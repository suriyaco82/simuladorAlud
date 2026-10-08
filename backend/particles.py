"""Motor exploratorio rápido (v0.1): partículas independientes sobre el lecho, Coulomb basal + amortiguamiento.

Sin interacción entre partículas ni reología: sirve para pre-visualizar trayectorias antes de correr MPM.
"""
from __future__ import annotations

import time

import numpy as np

from .scenario import bilinear


def run_particles(g, rel, prm, writer_factory, progress):
    dx = g["dx"]
    H = rel["H_bed"]
    ny, nx = H.shape
    gy, gx = np.gradient(H, dx)
    rng = np.random.default_rng(int(prm.get("random_seed", 42)))
    n_all = rel["x"].size
    n = min(n_all, int(prm["display_particles"]))
    idx = rng.choice(n_all, n, replace=False) if n < n_all else np.arange(n_all)
    x = rel["x"][idx].astype(float)
    y = rel["y"][idx].astype(float)
    vol = rel["vol"][idx].astype(float) * (rel["vol"].sum() / rel["vol"][idx].sum())
    vx = np.zeros(n)
    vy = np.zeros(n)
    active = np.ones(n, bool)
    lam = float(prm["pore_ratio_initial"])
    mu = np.tan(np.radians(prm["basal_friction_deg"])) * (1 - lam)
    grav = float(prm.get("gravity", 9.81))
    damping = float(prm.get("damping", 0.985))
    dt = float(prm.get("dt", 0.35))
    duration = float(prm["duration_s"])
    frame_dt = float(prm["frame_dt"])
    zmin = float(H.min()) - 5
    zmax = float(g["H_pre"].max()) + 50
    writer = writer_factory(zmin, zmax, 0.0)

    max_h = np.zeros((ny, nx), np.float32)
    max_v = np.zeros((ny, nx), np.float32)
    arrival = np.full((ny, nx), -1.0, np.float32)
    margin = 1.5 * dx
    Lx, Ly = (nx - 1) * dx, (ny - 1) * dx

    def columns(speed):
        i = np.clip(np.rint(x[active] / dx).astype(int), 0, nx - 1)
        j = np.clip(np.rint(y[active] / dx).astype(int), 0, ny - 1)
        dep = np.zeros((ny, nx))
        np.add.at(dep, (j, i), vol[active])
        vm = np.zeros((ny, nx))
        np.maximum.at(vm, (j, i), speed[active])
        return dep / (dx * dx), vm

    t = 0.0
    next_frame = 0.0
    step = 0
    t0 = time.time()
    while t <= duration + 1e-9:
        speed = np.hypot(vx, vy)
        if t >= next_frame - 1e-9:
            h, vm = columns(speed)
            np.maximum(max_h, h, out=max_h)
            np.maximum(max_v, vm, out=max_v)
            arrival[(h > 0.1) & (arrival < 0)] = t
            z = bilinear(H, dx, x, y) + 1.0
            writer.add_frame(t, x, y, z, speed, np.full(n, lam), np.where(active, 0, -1))
            next_frame += frame_dt
            progress(t=t, step=step, particles=int(active.sum()), vmax=float(speed.max(initial=0)), dt=dt)
        sx = bilinear(gx, dx, x, y)
        sy = bilinear(gy, dx, x, y)
        den = np.sqrt(1 + sx * sx + sy * sy)
        ax = -grav * sx / den
        ay = -grav * sy / den
        ux = np.divide(vx, speed, out=np.zeros(n), where=speed > 1e-6)
        uy = np.divide(vy, speed, out=np.zeros(n), where=speed > 1e-6)
        fric = mu * grav / den
        # Coulomb: no invierte el sentido del movimiento; en reposo retiene si la pendiente no supera μ
        slope_acc = np.hypot(ax, ay)
        at_rest = speed < fric * dt
        hold = at_rest & (slope_acc <= fric)
        ax = np.where(at_rest, ax * np.clip(1 - fric / np.maximum(slope_acc, 1e-9), 0, 1), ax - fric * ux)
        ay = np.where(at_rest, ay * np.clip(1 - fric / np.maximum(slope_acc, 1e-9), 0, 1), ay - fric * uy)
        vx = np.where(hold | ~active, 0, (vx + ax * dt) * damping)
        vy = np.where(hold | ~active, 0, (vy + ay * dt) * damping)
        x += vx * dt
        y += vy * dt
        out = (x < margin) | (x > Lx - margin) | (y < margin) | (y > Ly - margin)
        active &= ~out
        x = np.clip(x, 0, Lx)
        y = np.clip(y, 0, Ly)
        t += dt
        step += 1

    h, _ = columns(np.hypot(vx, vy))
    fields = dict(deposit=h.astype(np.float32), erosion=np.zeros((ny, nx), np.float32),
                  max_depth=max_h, max_speed=max_v, max_pore=np.full((ny, nx), lam, np.float32) * (max_h > 0),
                  arrival=arrival, bed_final=H.astype(np.float32))
    info = dict(device="numpy-cpu", steps=step, t_end=round(t - dt, 2), particles_final=int(active.sum()),
                outflow_volume_m3=round(float(vol[~active].sum()), 1), wall_solver_s=round(time.time() - t0, 1))
    return writer, fields, info
