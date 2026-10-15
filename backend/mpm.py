# Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
# SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
"""Solver MLS-MPM 3D (Taichi) para flujos granulares saturados sobre DEM. CPU o GPU (Metal/CUDA/Vulkan).

Física (mezcla monofásica sólido-agua):
- MLS-MPM / APIC con B-spline cuadrática (Hu et al., 2018).
- Elastoplasticidad Drucker-Prager sobre deformaciones logarítmicas (Klár et al., 2016).
- Fricción interna efectiva tan(φ)·(1-λ), λ = p_poros / σ_total (Iverson, 1997).
- λ evoluciona: relajación hacia el valor hidrostático con tiempo de disipación T_d,
  generación por contracción volumétrica (-κ·Sr·tr∇v) y disminución por dilatancia.
- Viscosidad newtoniana de la mezcla (agua + finos).
- Terreno como frontera de altura: Coulomb basal tan(δ)·(1-λ) en nodos bajo el lecho.
- Erosión/entrainment (McDougall & Hungr, 2005): dz/dt = E_s·h·|v| si |v| > v_c; el lecho
  desciende y el material erosionado se incorpora como partículas nuevas (conserva masa y momento).
- Deposición: material que se detiene; espesor final = Σ volumen de partículas por columna.
- Agua libre (lagos): fluido débilmente compresible (τ = K·J·(J−1)·I, sin tracción) + viscosidad,
  en la misma grilla que el material granular: el impacto de una avalancha transfiere momento al agua.
- Propiedades por partícula (densidad, φ, δ): varios cuerpos con materiales distintos (hielo, roca, agua).
- Rozamiento turbulento de Voellmy/Manning en el lecho: Δv = −g·|v|²/(ξ·h)·dt (ξ en m/s²).
Coordenadas internas: relativas al origen de la grilla (z interno = z - z0).
"""

import math
import time

import numpy as np
import taichi as ti


def init_taichi(device: str) -> str:
    import os
    arch = {"cpu": ti.cpu, "gpu": ti.gpu}.get(device, ti.gpu)
    kw = {}
    # hosting compartido (ver api.cgi): sin GPU y con pocos hilos, para no superar el límite de memoria virtual
    if os.environ.get("SIMULADOR_FORCE_CPU") == "1":
        arch = ti.cpu
    if os.environ.get("SIMULADOR_THREADS"):
        kw["cpu_max_num_threads"] = max(1, int(os.environ["SIMULADOR_THREADS"]))
    ti.init(arch=arch, default_fp=ti.f32, log_level=ti.WARN, offline_cache=True, random_seed=0, **kw)
    return ti.lang.impl.current_cfg().arch.name


@ti.data_oriented
class MPM3D:
    def __init__(self, H_bed, erod, dx, z0, nz, parts, capacity, prm, display_cap=30000):
        ny, nx = H_bed.shape
        self.nx, self.ny, self.nz = nx, ny, nz
        self.dx = float(dx)
        self.inv_dx = 1.0 / self.dx
        self.z0 = float(z0)
        self.capacity = int(capacity)

        E = float(prm["young_modulus"])
        nu = 0.3
        self.mu0 = E / (2 * (1 + nu))
        self.la0 = E * nu / ((1 + nu) * (1 - 2 * nu))
        self.rho = float(prm["rho"])
        self.g = float(prm.get("gravity", 9.81))
        self.tan_phi = math.tan(math.radians(prm["friction_angle_deg"]))
        self.tan_delta = math.tan(math.radians(prm["basal_friction_deg"]))
        self.eta = float(prm["viscosity_pa_s"])
        self.lam_eq = float(prm["lam_eq"])
        self.lam_max = 0.95
        self.t_diff = max(1e-3, float(prm["pore_diffusion_time_s"]))
        self.kappa = float(prm["pore_generation"]) * float(prm["saturation"])
        self.lam_bed = float(prm["lam_bed"])
        self.Es = float(prm["entrainment_coeff"])
        self.v_crit = float(prm["critical_velocity"])
        self.erosion_on = float(erod.max()) > 0 and self.Es > 0
        self.basal_band = 0.75 * self.dx
        self.ent_vol = (self.dx / int(prm["ppc"])) ** 3
        # columna con flujo coherente: al menos ~1/3 de las partículas de una capa (ppc²/3); con ppc 3 → 3,
        # con ppc 2 → 1 (cada partícula ya representa una lámina de dx/2 de espesor)
        self.min_count = max(1, int(prm["ppc"]) ** 2 // 3)
        if "mat" in parts and (parts["mat"] == 1).any():
            self.min_count = 1  # con agua libre, una partícula ya es una lámina real (no hay "spray" granular que filtrar)
        # material erosionado: granular (gravas, detritos) o en suspensión (limos finos → flujo hiperconcentrado)
        self.ent_mat = 1 if prm.get("entrained_as") == "suspension" else 0
        self.rho_ent = float(prm.get("suspension_density", 1600.0)) if self.ent_mat == 1 else self.rho
        self.lam_ent = 0.0 if self.ent_mat == 1 else self.lam_bed
        self.K_w = float(prm.get("water_bulk_modulus", 4e6))
        self.eta_w = float(prm.get("water_viscosity_pa_s", 5.0))
        self.xi = float(prm.get("turbulence_xi", 0.0))
        rho_min = float(np.min(parts["rho"])) if "rho" in parts else self.rho
        self.c_p = max(math.sqrt((self.la0 + 2 * self.mu0) / min(self.rho, rho_min)),
                       math.sqrt(self.K_w / 1000.0) if "mat" in parts and (parts["mat"] == 1).any() else 0.0)

        # grilla
        self.gv = ti.Vector.field(3, ti.f32, (nx, ny, nz))
        self.gm = ti.field(ti.f32, (nx, ny, nz))
        self.gmu = ti.field(ti.f32, (nx, ny, nz))  # Σ m·μ_efectivo (μ basal ponderado por masa)
        self.gxi = ti.field(ti.f32, (nx, ny, nz))  # Σ m/ξ (resistencia turbulenta ponderada por masa)
        # columnas (índice [i, j])
        self.H = ti.field(ti.f32, (nx, ny))
        self.erod = ti.field(ti.f32, (nx, ny))
        self.eroded = ti.field(ti.f32, (nx, ny))
        self.pend = ti.field(ti.f32, (nx, ny))
        self.cvol = ti.field(ti.f32, (nx, ny))
        self.cm = ti.field(ti.f32, (nx, ny))
        self.cmv = ti.Vector.field(3, ti.f32, (nx, ny))
        self.cvmax = ti.field(ti.f32, (nx, ny))
        self.cvv = ti.Vector.field(3, ti.f32, (nx, ny))  # Σ vol·v por columna (velocidad media de la columna)
        self.ccount = ti.field(ti.i32, (nx, ny))  # partículas por columna
        self.clmax = ti.field(ti.f32, (nx, ny))
        self.max_h = ti.field(ti.f32, (nx, ny))
        self.max_v = ti.field(ti.f32, (nx, ny))
        self.max_l = ti.field(ti.f32, (nx, ny))
        self.arrival = ti.field(ti.f32, (nx, ny))
        # brecha prescrita (rotura de morena): cota objetivo final y cota inicial por columna
        self.br_target = ti.field(ti.f32, (nx, ny))
        self.br_H0 = ti.field(ti.f32, (nx, ny))
        self.br_on = False
        self.br_removed = ti.field(ti.f32, ())
        # partículas
        cap = self.capacity
        self.x = ti.Vector.field(3, ti.f32, cap)
        self.v = ti.Vector.field(3, ti.f32, cap)
        self.C = ti.Matrix.field(3, 3, ti.f32, cap)
        self.F = ti.Matrix.field(3, 3, ti.f32, cap)
        self.Jp = ti.field(ti.f32, cap)
        self.vol0 = ti.field(ti.f32, cap)
        self.lam = ti.field(ti.f32, cap)
        self.flag = ti.field(ti.i32, cap)  # 0 desprendimiento, 1 erosionado, 2 agua, -1 fuera del dominio
        self.mat = ti.field(ti.i32, cap)   # 0 granular (Drucker-Prager), 1 agua
        self.rho_p = ti.field(ti.f32, cap)
        self.tphi_p = ti.field(ti.f32, cap)
        self.tdel_p = ti.field(ti.f32, cap)
        self.Jw = ti.field(ti.f32, cap)
        self.ixi_p = ti.field(ti.f32, cap)  # 1/ξ por partícula (0 = sin resistencia turbulenta)
        self.n = ti.field(ti.i32, ())
        self.outflow = ti.field(ti.f32, ())
        self.vmax = ti.field(ti.f32, ())
        self.n_moving = ti.field(ti.i32, ())
        self.n_active = ti.field(ti.i32, ())
        # subconjunto para visualización: ranura fija por partícula -> interpolable entre cuadros
        n0 = parts["x"].size
        self.display_cap = int(display_cap)
        self.stride = max(1, math.ceil(min(cap, 2 * n0) / self.display_cap))
        self.dx_ = ti.Vector.field(3, ti.f32, self.display_cap)
        self.ds_ = ti.field(ti.f32, self.display_cap)
        self.dl_ = ti.field(ti.f32, self.display_cap)
        self.df_ = ti.field(ti.i32, self.display_cap)

        # carga inicial
        X = np.zeros((cap, 3), np.float32)
        X[:n0, 0] = parts["x"]
        X[:n0, 1] = parts["y"]
        X[:n0, 2] = parts["z"] - self.z0
        V0 = np.zeros(cap, np.float32)
        V0[:n0] = parts["vol"]
        L0 = np.zeros(cap, np.float32)
        L0[:n0] = float(prm["pore_ratio_initial"])
        if "lam0" in parts:
            L0[:n0] = parts["lam0"]
        FL = np.full(cap, -1, np.int32)
        FL[:n0] = parts["flag"] if "flag" in parts else 0
        def per(name, default, dtype=np.float32):
            a = np.full(cap, default, dtype)
            if name in parts:
                a[:n0] = parts[name]
            return a
        self.mat.from_numpy(per("mat", 0, np.int32))
        self.rho_p.from_numpy(per("rho", self.rho))
        self.tphi_p.from_numpy(per("tphi", self.tan_phi))
        self.tdel_p.from_numpy(per("tdelta", self.tan_delta))
        self.Jw.from_numpy(per("J0", 1.0))
        self.ixi = 1.0 / self.xi if self.xi > 0 else 0.0
        self.ixi_p.from_numpy(per("ixi", self.ixi))
        self.xi_on = self.xi > 0 or ("ixi" in parts and float(np.max(parts["ixi"])) > 0)
        self.x.from_numpy(X)
        self.vol0.from_numpy(V0)
        self.lam.from_numpy(L0)
        self.flag.from_numpy(FL)
        self.n[None] = n0
        self.H.from_numpy(np.ascontiguousarray((H_bed - self.z0).T, dtype=np.float32))
        self.erod.from_numpy(np.ascontiguousarray(erod.T, dtype=np.float32))
        self.arrival.fill(-1.0)
        self._init_particles()

    # ------------------------------------------------------------------ utilidades
    @ti.kernel
    def _init_particles(self):
        for p in range(self.capacity):
            self.F[p] = ti.Matrix.identity(ti.f32, 3)
            self.C[p] = ti.Matrix.zero(ti.f32, 3, 3)
            self.v[p] = ti.Vector.zero(ti.f32, 3)
            self.Jp[p] = 0.0

    @ti.func
    def col_normal(self, i, j):
        i0 = ti.max(i - 1, 0)
        i1 = ti.min(i + 1, self.nx - 1)
        j0 = ti.max(j - 1, 0)
        j1 = ti.min(j + 1, self.ny - 1)
        hx = (self.H[i1, j] - self.H[i0, j]) / (ti.cast(i1 - i0, ti.f32) * self.dx)
        hy = (self.H[i, j1] - self.H[i, j0]) / (ti.cast(j1 - j0, ti.f32) * self.dx)
        return ti.Vector([-hx, -hy, 1.0]).normalized()

    @ti.func
    def bed_at(self, px, py):
        fx = ti.min(ti.max(px * self.inv_dx, 0.0), self.nx - 1.001)
        fy = ti.min(ti.max(py * self.inv_dx, 0.0), self.ny - 1.001)
        i = ti.cast(fx, ti.i32)
        j = ti.cast(fy, ti.i32)
        tx = fx - i
        ty = fy - j
        h00 = self.H[i, j]
        h10 = self.H[i + 1, j]
        h01 = self.H[i, j + 1]
        h11 = self.H[i + 1, j + 1]
        h = (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty
        hx = ((h10 - h00) * (1 - ty) + (h11 - h01) * ty) * self.inv_dx
        hy = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) * self.inv_dx
        return h, ti.Vector([-hx, -hy, 1.0]).normalized()

    @ti.func
    def column_of(self, p):
        i = ti.min(ti.max(ti.cast(self.x[p][0] * self.inv_dx + 0.5, ti.i32), 0), self.nx - 1)
        j = ti.min(ti.max(ti.cast(self.x[p][1] * self.inv_dx + 0.5, ti.i32), 0), self.ny - 1)
        return i, j

    # ------------------------------------------------------------------ paso MPM
    @ti.kernel
    def clear_grid(self):
        for I in ti.grouped(self.gm):
            self.gv[I] = ti.Vector.zero(ti.f32, 3)
            self.gm[I] = 0.0
            self.gmu[I] = 0.0
            self.gxi[I] = 0.0

    @ti.kernel
    def p2g(self, dt: ti.f32):
        for p in range(self.n[None]):
            if self.flag[p] < 0:
                continue
            Xp = self.x[p] * self.inv_dx
            base = ti.cast(Xp - 0.5, ti.i32)
            fx = Xp - ti.cast(base, ti.f32)
            w = [0.5 * (1.5 - fx) ** 2, 0.75 - (fx - 1.0) ** 2, 0.5 * (fx - 0.5) ** 2]
            C = self.C[p]
            stress = ti.Matrix.zero(ti.f32, 3, 3)
            mu_eff = 0.0
            lam = 0.0
            if self.mat[p] == 1:
                # agua: débilmente compresible, sin tracción (superficie libre)
                J = self.Jw[p] * (1.0 + dt * C.trace())
                J = ti.min(ti.max(J, 0.6), 1.0)
                self.Jw[p] = J
                stress = ti.Matrix.identity(ti.f32, 3) * (self.K_w * J * (J - 1.0))
                stress += self.eta_w * (C + C.transpose())
            else:
                # presión de poros
                lam = self.lam[p]
                lam += dt * (-(lam - self.lam_eq) / self.t_diff - self.kappa * C.trace())
                lam = ti.min(ti.max(lam, 0.0), self.lam_max)
                self.lam[p] = lam
                mu_eff = self.tdel_p[p] * (1.0 - lam)

                # Drucker-Prager con fricción efectiva
                F = (ti.Matrix.identity(ti.f32, 3) + dt * C) @ self.F[p]
                U, sig, V = ti.svd(F)
                tphi = self.tphi_p[p] * (1.0 - lam)
                sphi = tphi / ti.sqrt(1.0 + tphi * tphi)
                alpha = ti.sqrt(2.0 / 3.0) * 2.0 * sphi / (3.0 - sphi)
                eps = ti.Vector([ti.log(ti.max(ti.abs(sig[d, d]), 1e-4)) for d in ti.static(range(3))])
                tr = eps.sum() + self.Jp[p]
                eh = eps - tr / 3.0
                ehn = eh.norm() + 1e-20
                new_eps = eps
                if tr >= 0.0:
                    # tracción: el material granular sin cohesión se separa (tensión nula)
                    self.Jp[p] = tr
                    new_eps = ti.Vector.zero(ti.f32, 3)
                else:
                    self.Jp[p] = 0.0
                    dg = ehn + (3.0 * self.la0 + 2.0 * self.mu0) / (2.0 * self.mu0) * tr * alpha
                    if dg > 0.0:
                        new_eps = eps - dg / ehn * eh
                sig_new = ti.Matrix([[ti.exp(new_eps[0]), 0.0, 0.0],
                                     [0.0, ti.exp(new_eps[1]), 0.0],
                                     [0.0, 0.0, ti.exp(new_eps[2])]])
                Fn = U @ sig_new @ V.transpose()
                self.F[p] = Fn
                lsum = new_eps.sum()
                center = ti.Matrix.zero(ti.f32, 3, 3)
                for d in ti.static(range(3)):
                    center[d, d] = (2.0 * self.mu0 * new_eps[d] + self.la0 * lsum) / sig_new[d, d]
                stress = U @ center @ V.transpose() @ Fn.transpose()
                stress += self.eta * (C + C.transpose())

            mass = self.rho_p[p] * self.vol0[p]
            affine = (-dt * self.vol0[p] * 4.0 * self.inv_dx * self.inv_dx) * stress + mass * C
            vp = self.v[p]
            for i, j, k in ti.static(ti.ndrange(3, 3, 3)):
                offs = ti.Vector([i, j, k])
                dpos = (ti.cast(offs, ti.f32) - fx) * self.dx
                weight = w[i][0] * w[j][1] * w[k][2]
                I = base + offs
                self.gv[I] += weight * (mass * vp + affine @ dpos)
                self.gm[I] += weight * mass
                self.gmu[I] += weight * mass * mu_eff
                self.gxi[I] += weight * mass * self.ixi_p[p]

    @ti.kernel
    def grid_op(self, dt: ti.f32):
        for i, j, k in self.gm:
            m = self.gm[i, j, k]
            if m > 0.0:
                v = self.gv[i, j, k] / m
                v[2] -= dt * self.g
                if ti.cast(k, ti.f32) * self.dx < self.H[i, j]:
                    # μ basal ponderado por masa: agua ≈ 0, hielo/roca/detritos según su δ y λ
                    mu = self.gmu[i, j, k] / m
                    nrm = self.col_normal(i, j)
                    vn = v.dot(nrm)
                    if vn < 0.0:
                        vt = v - vn * nrm
                        vtn = vt.norm()
                        s = 0.0
                        if vtn > 1e-9:
                            s = ti.max(0.0, 1.0 + mu * vn / vtn)
                        v = vt * s

                ixi = self.gxi[i, j, k] / m
                if ixi > 0.0:
                    # Voellmy/Manning: resistencia turbulenta de la columna, dv/dt = −g·|v|²/(ξ·h),
                    # aplicada a todos los nodos entre el lecho y la superficie del flujo (implícita, estable)
                    h = ti.max(self.cvol[i, j] / (self.dx * self.dx), 0.5)
                    z = ti.cast(k, ti.f32) * self.dx
                    if z < self.H[i, j] + h + self.dx:
                        nrm = self.col_normal(i, j)
                        vn = v.dot(nrm)
                        vt2 = v - vn * nrm
                        v = vn * nrm + vt2 / (1.0 + dt * self.g * vt2.norm() * ixi / h)
                if k < 3 and v[2] < 0.0:
                    v[2] = 0.0
                if k > self.nz - 4 and v[2] > 0.0:
                    v[2] = 0.0
                self.gv[i, j, k] = v

    @ti.kernel
    def g2p(self, dt: ti.f32):
        margin = 2.5 * self.dx
        xmax = (self.nx - 1) * self.dx - margin
        ymax = (self.ny - 1) * self.dx - margin
        for p in range(self.n[None]):
            if self.flag[p] < 0:
                continue
            Xp = self.x[p] * self.inv_dx
            base = ti.cast(Xp - 0.5, ti.i32)
            fx = Xp - ti.cast(base, ti.f32)
            w = [0.5 * (1.5 - fx) ** 2, 0.75 - (fx - 1.0) ** 2, 0.5 * (fx - 0.5) ** 2]
            new_v = ti.Vector.zero(ti.f32, 3)
            new_C = ti.Matrix.zero(ti.f32, 3, 3)
            for i, j, k in ti.static(ti.ndrange(3, 3, 3)):
                offs = ti.Vector([i, j, k])
                dpos = ti.cast(offs, ti.f32) - fx
                weight = w[i][0] * w[j][1] * w[k][2]
                gvv = self.gv[base + offs]
                new_v += weight * gvv
                new_C += 4.0 * self.inv_dx * weight * gvv.outer_product(dpos)
            xn = self.x[p] + dt * new_v
            hb, nrm = self.bed_at(xn[0], xn[1])
            if xn[2] < hb:
                xn[2] = hb
                vn = new_v.dot(nrm)
                if vn < 0.0:
                    # el soporte del lecho también genera fricción de Coulomb
                    vt = new_v - vn * nrm
                    vtn = vt.norm()
                    mu = 0.0
                    if self.mat[p] == 0:
                        mu = self.tdel_p[p] * (1.0 - self.lam[p])
                    s = 0.0
                    if vtn > 1e-9:
                        s = ti.max(0.0, 1.0 + mu * vn / vtn)
                    new_v = vt * s
            xn[2] = ti.min(ti.max(xn[2], self.dx), (self.nz - 2.5) * self.dx)
            if xn[0] < margin or xn[0] > xmax or xn[1] < margin or xn[1] > ymax:
                self.flag[p] = -1
                ti.atomic_add(self.outflow[None], self.vol0[p])
            self.x[p] = xn
            self.v[p] = new_v
            self.C[p] = new_C

    # ------------------------------------------------------------------ columnas / erosión
    @ti.kernel
    def accumulate_columns(self):
        for i, j in self.H:
            self.cvol[i, j] = 0.0
            self.cm[i, j] = 0.0
            self.cmv[i, j] = ti.Vector.zero(ti.f32, 3)
            self.cvmax[i, j] = 0.0
            self.cvv[i, j] = ti.Vector.zero(ti.f32, 3)
            self.ccount[i, j] = 0
            self.clmax[i, j] = 0.0
        for p in range(self.n[None]):
            if self.flag[p] >= 0:
                i, j = self.column_of(p)
                vol = self.vol0[p]
                if self.mat[p] == 1:
                    vol *= self.Jw[p]  # volumen actual del agua (débilmente compresible)
                ti.atomic_add(self.cvol[i, j], vol)
                ti.atomic_max(self.cvmax[i, j], self.v[p].norm())
                ti.atomic_add(self.cvv[i, j], vol * self.v[p])
                ti.atomic_add(self.ccount[i, j], 1)
                if self.mat[p] == 0:
                    ti.atomic_max(self.clmax[i, j], self.lam[p])
                if self.x[p][2] - self.H[i, j] < self.basal_band:
                    mass = self.rho_p[p] * self.vol0[p]
                    ti.atomic_add(self.cm[i, j], mass)
                    ti.atomic_add(self.cmv[i, j], mass * self.v[p])

    @ti.kernel
    def erode(self, dt: ti.f32):
        area = self.dx * self.dx
        s = self.ent_vol ** (1.0 / 3.0)
        for i, j in self.H:
            if self.cm[i, j] > 0.0 and self.erod[i, j] > 0.0 and self.n[None] < self.capacity - 8:
                vb = self.cmv[i, j] / self.cm[i, j]
                sp = vb.norm()
                if sp > self.v_crit:
                    h = self.cvol[i, j] / area
                    dz = ti.min(self.Es * h * sp * dt, self.erod[i, j])
                    self.H[i, j] -= dz
                    self.erod[i, j] -= dz
                    self.eroded[i, j] += dz
                    self.pend[i, j] += dz * area
                    spawned = 0
                    while self.pend[i, j] >= self.ent_vol and spawned < 8:
                        idx = ti.atomic_add(self.n[None], 1)
                        if idx < self.capacity:
                            self.x[idx] = ti.Vector([(i + ti.random() - 0.5) * self.dx,
                                                     (j + ti.random() - 0.5) * self.dx,
                                                     self.H[i, j] + 0.5 * s])
                            self.v[idx] = ti.Vector.zero(ti.f32, 3)
                            self.C[idx] = ti.Matrix.zero(ti.f32, 3, 3)
                            self.F[idx] = ti.Matrix.identity(ti.f32, 3)
                            self.Jp[idx] = 0.0
                            self.vol0[idx] = self.ent_vol
                            self.lam[idx] = self.lam_ent
                            self.flag[idx] = 1
                            self.mat[idx] = self.ent_mat
                            self.rho_p[idx] = self.rho_ent
                            self.tphi_p[idx] = self.tan_phi
                            self.tdel_p[idx] = self.tan_delta
                            self.Jw[idx] = 1.0
                            self.ixi_p[idx] = self.ixi
                        self.pend[i, j] -= self.ent_vol
                        spawned += 1

    def set_breach(self, target, start_s, duration_s):
        """target: (ny, nx) cota final del lecho en la brecha (NaN fuera de la brecha)."""
        t = np.where(np.isfinite(target), target - self.z0, 1e9).astype(np.float32)
        self.br_target.from_numpy(np.ascontiguousarray(t.T))
        self.br_H0.from_numpy(self.H.to_numpy())
        self.br_start, self.br_dur = float(start_s), max(1.0, float(duration_s))
        self.br_on = True

    @ti.kernel
    def breach(self, frac: ti.f32):
        # la cota del lecho desciende linealmente hacia la cota objetivo; el material removido se considera
        # evacuado por el flujo (se contabiliza en br_removed, no se reinyecta como partículas en la brecha)
        area = self.dx * self.dx
        for i, j in self.H:
            tg = self.br_target[i, j]
            if tg < 1e8:
                goal = self.br_H0[i, j] - (self.br_H0[i, j] - tg) * frac
                if self.H[i, j] > goal:
                    dz = self.H[i, j] - goal
                    self.H[i, j] = goal
                    self.eroded[i, j] += dz
                    ti.atomic_add(self.br_removed[None], dz * area)

    @ti.kernel
    def clamp_n(self):
        if self.n[None] > self.capacity:
            self.n[None] = self.capacity

    @ti.kernel
    def record(self, t: ti.f32):
        # solo columnas con flujo coherente (≥ min_count partículas): las partículas sueltas que salen
        # despedidas por delante del frente no definen profundidad, velocidad ni arribo
        area = self.dx * self.dx
        for i, j in self.H:
            if self.ccount[i, j] >= self.min_count:
                h = self.cvol[i, j] / area
                self.max_h[i, j] = ti.max(self.max_h[i, j], h)
                vbar = (self.cvv[i, j] / self.cvol[i, j]).norm()
                self.max_v[i, j] = ti.max(self.max_v[i, j], vbar)
                self.max_l[i, j] = ti.max(self.max_l[i, j], self.clmax[i, j])
                if h > 0.1 and self.arrival[i, j] < 0.0:
                    self.arrival[i, j] = t

    @ti.kernel
    def compute_vmax(self, v_stop: ti.f32):
        self.vmax[None] = 0.0
        self.n_moving[None] = 0
        self.n_active[None] = 0
        for p in range(self.n[None]):
            if self.flag[p] >= 0:
                sp = self.v[p].norm()
                ti.atomic_max(self.vmax[None], sp)
                ti.atomic_add(self.n_active[None], 1)
                if sp > v_stop:
                    ti.atomic_add(self.n_moving[None], 1)

    # ------------------------------------------------------------------ salida
    @ti.kernel
    def gather(self):
        for p in range(self.n[None]):
            if p % self.stride == 0:
                s = p // self.stride
                if s < self.display_cap:
                    self.dx_[s] = self.x[p]
                    self.ds_[s] = self.v[p].norm()
                    self.dl_[s] = self.lam[p]
                    self.df_[s] = self.flag[p]

    def snapshot(self):
        self.gather()
        n = int(self.n[None])
        cnt = min(self.display_cap, -(-n // self.stride))
        X = self.dx_.to_numpy()[:cnt]
        return (X[:, 0], X[:, 1], X[:, 2] + self.z0, self.ds_.to_numpy()[:cnt],
                self.dl_.to_numpy()[:cnt], self.df_.to_numpy()[:cnt])

    def cols(self, field):
        return field.to_numpy().T.copy()

    # ------------------------------------------------------------------ bucle principal
    def run(self, duration, frame_dt, on_frame, on_progress, cfl=0.35, v_stop=0.3, t_min=10.0):
        t = 0.0
        step = 0
        next_frame = 0.0
        vmax = 0.0
        eta_max = max(self.eta, self.eta_w)
        dt_visc = 1000.0 * self.dx ** 2 / (6.0 * eta_max) if eta_max > 0 else 1e9
        last_report = 0.0
        stopped_early = False
        while t < duration:
            dt = min(cfl * self.dx / (self.c_p + vmax), 0.5 * self.dx / max(vmax, 1e-3), dt_visc, 0.1)
            if t >= next_frame - 1e-9:
                self.accumulate_columns()
                self.record(t)
                on_frame(t, *self.snapshot(), self.cols(self.eroded) if (self.erosion_on or self.br_on) else None)
                next_frame += frame_dt
            self.clear_grid()
            self.p2g(dt)
            self.grid_op(dt)
            self.g2p(dt)
            if self.erosion_on or self.xi_on or step % 5 == 0:
                self.accumulate_columns()
            if self.erosion_on:
                self.erode(dt)
                self.clamp_n()
            if self.br_on and t >= self.br_start and step % 5 == 0:
                self.breach(min(1.0, (t - self.br_start) / self.br_dur))
                self.clamp_n()
            t += dt
            step += 1
            if step % 5 == 0:
                self.record(t)
            if step % 20 == 0:
                self.compute_vmax(v_stop)
                vmax = float(self.vmax[None])
                moving = int(self.n_moving[None]) / max(1, int(self.n_active[None]))
                if not math.isfinite(vmax):
                    raise RuntimeError("Inestabilidad numérica (velocidad no finita). Aumentá dx o reducí el módulo elástico.")
                now = time.time()
                if now - last_report > 0.5:
                    on_progress(t, step, int(self.n[None]), vmax, dt)
                    last_report = now
                # parada robusta: se mueve menos del 0,2% del material (partículas aisladas no la bloquean)
                if t > t_min and (vmax < v_stop or moving < 0.002) and not (self.br_on and t < self.br_start + self.br_dur):
                    stopped_early = True
                    break
        self.accumulate_columns()
        self.record(t)
        on_frame(t, *self.snapshot(), self.cols(self.eroded) if (self.erosion_on or self.br_on) else None)
        return dict(t_end=t, steps=step, stopped_early=stopped_early)


def run_mpm(g, rel, erod, prm, writer_factory, progress):
    """Configura el solver sobre el escenario y escribe resultados. Devuelve (meta, campos, info)."""
    dx = g["dx"]
    device = init_taichi(prm.get("device", "auto"))
    progress(stage=f"Inicializando MPM en {device}")
    ero_max = float(erod.max()) if erod.size else 0.0
    br = prm.get("_breach")
    if br is not None:
        ero_max = max(ero_max, float(np.nanmax(br["depth"])))
    z0 = float(min(rel["H_bed"].min(), g["H_pre"].min())) - ero_max - 3 * dx
    ztop = max(float(g["H_pre"].max()), rel["info"]["top_z"]) + max(8 * dx, 2 * rel["info"]["max_thickness_m"])
    nz = int(math.ceil((ztop - z0) / dx)) + 3
    n0 = int(rel["x"].size)
    n_ent = 0
    if ero_max > 0 and prm["entrainment_coeff"] > 0:
        n_ent = int(min(float(erod.sum()) * dx * dx / ((dx / prm["ppc"]) ** 3), prm["max_particles"] - n0))
    capacity = max(n0 + 16, min(int(prm["max_particles"]), n0 + max(0, n_ent)))
    solver = MPM3D(rel["H_bed"], erod, dx, z0, nz, rel, capacity, prm, int(prm["display_particles"]))
    if br is not None:
        solver.set_breach(br["target"], br["start_s"], br["duration_s"])
    writer = writer_factory(z0, z0 + nz * dx, ero_max)

    # estaciones de aforo: caudal Q = Σ h·(v·n)·dx a través de una sección transversal
    gauges = []
    fr = g["frame"]
    for gg in prm.get("gauges") or []:
        (lo0, la0), (lo1, la1) = gg["section"]
        x0, y0 = fr.to_xy(lo0, la0); x1, y1 = fr.to_xy(lo1, la1)
        L = float(np.hypot(x1 - x0, y1 - y0))
        ns = max(2, int(L / (dx / 2)))
        xs, ys = np.linspace(x0, x1, ns), np.linspace(y0, y1, ns)
        ii = np.clip(np.rint(xs / dx).astype(int), 0, solver.nx - 1); jj = np.clip(np.rint(ys / dx).astype(int), 0, solver.ny - 1)
        cells = sorted(set(zip(ii.tolist(), jj.tolist())))
        tx, ty = (x1 - x0) / L, (y1 - y0) / L
        nrm = np.array([ty, -tx, 0.0])  # normal a la sección (sentido elegido por el orden de los puntos)
        gauges.append(dict(name=gg["name"], lon=(lo0 + lo1) / 2, lat=(la0 + la1) / 2, cells=cells, n=nrm,
                           width=L, t=[], Q=[], h=[], v=[]))

    def gauge_step(t):
        if not gauges:
            return
        cvol = solver.cvol.to_numpy(); cvv = solver.cvv.to_numpy(); cnt = solver.ccount.to_numpy()
        for G in gauges:
            I = np.array([c[0] for c in G["cells"]]); J = np.array([c[1] for c in G["cells"]])
            vol, vv, cn = cvol[I, J], cvv[I, J], cnt[I, J]
            ok = cn >= solver.min_count
            h = np.where(ok, vol / (dx * dx), 0.0)
            vel = np.where(ok[:, None], vv / np.maximum(vol, 1e-9)[:, None], 0.0)
            q = h * (vel @ G["n"])
            # la sección se recorre con celdas de ancho ≈ ancho/n_celdas
            G["t"].append(round(float(t), 1)); G["Q"].append(round(float(np.abs(q.sum()) * G["width"] / max(len(I), 1)), 1))
            G["h"].append(round(float(h.max()), 2)); G["v"].append(round(float(np.linalg.norm(vel, axis=1).max()), 2))

    def on_frame(t, x, y, z, s, l, f, eroded):
        writer.add_frame(t, x, y, z, s, l, f, eroded)
        gauge_step(t)

    def on_progress(t, step, n, vmax, dt):
        progress(t=t, step=step, particles=n, vmax=vmax, dt=dt)

    progress(stage="Compilando kernels (la primera vez tarda)…")
    t0 = time.time()
    run_info = solver.run(float(prm["duration_s"]), float(prm["frame_dt"]), on_frame, on_progress)
    fields = dict(
        deposit=solver.cols(solver.cvol) / (dx * dx),
        erosion=solver.cols(solver.eroded),
        max_depth=solver.cols(solver.max_h),
        max_speed=solver.cols(solver.max_v),
        max_pore=solver.cols(solver.max_l),
        arrival=solver.cols(solver.arrival),
        bed_final=solver.cols(solver.H) + z0,
    )
    info = dict(device=device, grid=[solver.nx, solver.ny, nz], nodes=solver.nx * solver.ny * nz,
                capacity=capacity, particles_final=int(solver.n[None]),
                outflow_volume_m3=round(float(solver.outflow[None]), 1),
                entrained_pending_m3=round(float(solver.pend.to_numpy().sum()), 1),
                breach_removed_m3=round(float(solver.br_removed[None]), 1),
                dt_elastic=round(0.35 * dx / solver.c_p, 4), wall_solver_s=round(time.time() - t0, 1),
                **run_info)
    info["gauges"] = [{k: G[k] for k in ("name", "lon", "lat", "width", "t", "Q", "h", "v")} for G in gauges]
    return writer, fields, info
