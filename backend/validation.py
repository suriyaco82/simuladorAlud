# Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
# SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
"""Verificación del solver MPM contra soluciones analíticas (bloque deslizante sobre plano inclinado).

a = g·(sin θ − tan δ·(1−λ)·cos θ)

Uso:  python -m backend.validation [gpu|cpu]
"""
import math
import sys

import numpy as np

from . import mpm

CASES = [  # θ, δ, λ, dx, espesor
    (30, 20, 0.0, 10, 20),
    (30, 20, 0.0, 25, 20),
    (40, 10, 0.0, 10, 20),
    (25, 15, 0.0, 10, 5),
    (30, 20, 0.5, 10, 20),
    (15, 20, 0.0, 10, 20),  # θ < δ: debe permanecer en reposo
]


def sliding_block(theta, delta, lam, dx, thick, duration=12.0):
    nx, ny = int(3000 / dx), int(600 / dx)
    tan_t = math.tan(math.radians(theta))
    H = np.tile((3000 - np.arange(nx) * dx * tan_t)[None, :], (ny, 1)).astype(np.float32)
    s = dx / 3
    PX, PY = np.meshgrid(np.arange(300, 500, s), np.arange(200, 400, s))
    PX, PY = PX.ravel(), PY.ravel()
    nL = max(1, round(thick / s))
    hz = thick / nL
    top = 3000 - PX * tan_t
    Z = np.concatenate([top + (k + 0.5) * hz / math.cos(math.radians(theta)) for k in range(nL)])
    parts = dict(x=np.tile(PX, nL).astype(np.float32), y=np.tile(PY, nL).astype(np.float32),
                 z=Z.astype(np.float32), vol=np.full(Z.size, s * s * hz, np.float32))
    prm = dict(young_modulus=2e7, rho=2000, friction_angle_deg=35, basal_friction_deg=delta, viscosity_pa_s=0,
               lam_eq=lam, pore_diffusion_time_s=1e6, pore_generation=0, saturation=0, lam_bed=lam,
               entrainment_coeff=0, critical_velocity=1, erodible_depth_m=0, ppc=3, pore_ratio_initial=lam)
    z0 = float(H.min()) - 3 * dx
    nz = int((H.max() + 10 * dx - z0) / dx)
    sol = mpm.MPM3D(H, np.zeros_like(H), dx, z0, nz, parts, parts["x"].size, prm, 1000)
    rec = []

    def on_frame(t, *_):
        v = sol.v.to_numpy()[: sol.n[None]]
        rec.append((t, float(np.linalg.norm(v, axis=1).mean())))

    sol.run(duration, 1.0, on_frame, lambda *a: None, t_min=1e9)
    t = np.array([r[0] for r in rec])
    v = np.array([r[1] for r in rec])
    m = (t > 2) & (t < duration - 1)
    return float(np.polyfit(t[m], v[m], 1)[0]), float(v[-1])


def _water_parts(X, Y, Z, s, zsurf):
    J0 = 1.0 - 1000.0 * 9.81 * np.maximum(zsurf - Z, 0) / 4e6  # compresión hidrostática inicial
    n = X.size
    return dict(x=X.astype(np.float32), y=Y.astype(np.float32), z=Z.astype(np.float32),
                vol=np.full(n, s ** 3, np.float32), mat=np.ones(n, np.int32), rho=np.full(n, 1000.0, np.float32),
                flag=np.full(n, 2, np.int32), J0=J0.astype(np.float32), lam0=np.zeros(n, np.float32))


def _water_prm(xi=0.0):
    return dict(young_modulus=2e7, rho=2000, friction_angle_deg=35, basal_friction_deg=20, viscosity_pa_s=0,
                lam_eq=0, pore_diffusion_time_s=60, pore_generation=0, saturation=0, lam_bed=0, entrainment_coeff=0,
                critical_velocity=1, erodible_depth_m=0, ppc=2, pore_ratio_initial=0, water_bulk_modulus=4e6,
                water_viscosity_pa_s=1.0, turbulence_xi=xi)


def dam_break(dx=2.0, h0=10.0, t_end=6.0):
    """Ritter: frente de una columna de agua sobre fondo horizontal liso avanza a 2·√(g·h0)."""
    nx, ny = int(400 / dx), int(40 / dx)
    H = np.full((ny, nx), 100.0, np.float32)
    s = dx / 2
    X, Y, Z = np.meshgrid(np.arange(20 + s / 2, 60, s), np.arange(8 + s / 2, 32, s), np.arange(100 + s / 2, 100 + h0, s), indexing="ij")
    parts = _water_parts(X.ravel(), Y.ravel(), Z.ravel(), s, 100 + h0)
    sol = mpm.MPM3D(H, np.zeros_like(H), dx, 100 - 3 * dx, int((h0 + 12 * dx) / dx) + 3, parts, parts["x"].size, _water_prm(), 1000)
    rec = []
    def front(t, *_):
        n = sol.n[None]; act = sol.flag.to_numpy()[:n] >= 0
        rec.append((t, float(np.percentile(sol.x.to_numpy()[:n][act, 0], 99.9))))
    sol.run(t_end, 0.5, front,
            lambda *a: None, t_min=1e9)
    t = np.array([r[0] for r in rec]); xf = np.array([r[1] for r in rec])
    m = t >= 2.0
    return float(np.polyfit(t[m], xf[m], 1)[0]), 2 * math.sqrt(9.81 * h0)


def voellmy_sheet(theta=5.0, h=2.0, xi=500.0, dx=4.0, t_end=60.0):
    """Lámina de agua en pendiente con resistencia de Voellmy (μ=0): v_terminal = √(ξ·h·sin θ)."""
    nx, ny = int(4000 / dx), int(140 / dx)
    tan_t = math.tan(math.radians(theta))
    H = np.tile((1000 - np.arange(nx) * dx * tan_t)[None, :], (ny, 1)).astype(np.float32)
    s = dx / 2
    X, Y = np.meshgrid(np.arange(200, 700, s), np.arange(30, 110, s), indexing="ij")
    X, Y = X.ravel(), Y.ravel()
    nL = max(1, round(h / s)); hz = h / nL
    top = 1000 - X * tan_t
    Z = np.concatenate([top + (k + 0.5) * hz for k in range(nL)])
    parts = _water_parts(np.tile(X, nL), np.tile(Y, nL), Z, s, np.tile(top + h, nL))
    parts["vol"] = np.full(Z.size, s * s * hz, np.float32)
    z0 = float(H.min()) - 3 * dx
    sol = mpm.MPM3D(H, np.zeros_like(H), dx, z0, int((H.max() + 10 * dx - z0) / dx), parts, parts["x"].size, _water_prm(xi), 1000)
    rec = []
    def speed(t, *_):
        # velocidad y espesor medidos en el cuerpo del flujo (columnas con ≥ 3 partículas)
        cnt = sol.ccount.to_numpy(); vol = sol.cvol.to_numpy(); cv = sol.cvv.to_numpy()
        m = cnt >= 3
        vb = np.linalg.norm(cv[m], axis=1) / vol[m]
        rec.append((t, float(np.median(vb)), float(np.median(vol[m] / dx ** 2))))
    sol.run(t_end, 2.0, speed, lambda *a: None, t_min=1e9)
    t, v_num, h_num = rec[-1]
    return v_num, math.sqrt(xi * h_num * math.sin(math.radians(theta))), h_num


def main_water():
    print("── agua")
    v_num, v_th = dam_break()
    print(f"ruptura de presa (Ritter): frente {v_num:.1f} m/s vs {v_th:.1f} m/s teórico ({(v_num / v_th - 1) * 100:+.0f}%)")
    for h, xi, th in ((2.0, 500, 5), (6.0, 500, 5), (3.0, 200, 10)):
        v_num, v_th, h_num = voellmy_sheet(theta=th, h=h, xi=xi)
        print(f"lámina Voellmy (ξ={xi}, θ={th}°, h medido {h_num:.2f} m): v {v_num:.2f} vs √(ξ·h·sinθ) = {v_th:.2f} m/s ({(v_num / v_th - 1) * 100:+.0f}%)")


def main():
    device = sys.argv[1] if len(sys.argv) > 1 else "gpu"
    print("dispositivo:", mpm.init_taichi(device))
    print(f"{'θ':>4} {'δ':>4} {'λ':>4} {'dx':>4} {'h':>4} | {'a teórica':>9} {'a MPM':>7} {'error':>7}")
    ok = True
    for theta, delta, lam, dx, h in CASES:
        g = 9.81
        a_th = g * (math.sin(math.radians(theta)) - math.tan(math.radians(delta)) * (1 - lam) * math.cos(math.radians(theta)))
        a_num, v_end = sliding_block(theta, delta, lam, dx, h)
        if a_th > 0:
            err = (a_num - a_th) / a_th
            passed = abs(err) < 0.05
            e = f"{err * 100:+6.1f}%"
        else:
            passed = v_end < 1.0
            e = f"v={v_end:.2f}"
        ok &= passed
        print(f"{theta:4} {delta:4} {lam:4} {dx:4} {h:4} | {max(a_th, 0):9.2f} {a_num:7.2f} {e:>7} {'OK' if passed else 'FALLA'}")
    if "--agua" in sys.argv:
        main_water()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
