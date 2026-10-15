// Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
// SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
// Paletas de color compartidas por la escena, el mapa, los informes y las comparaciones.
export const RAMPS = {
  speed: ['#39a8ff', '#41e280', '#ffe55c', '#ff8a3d', '#e847ff'],
  depth: ['#320a5e', '#781c6d', '#bc3754', '#ed6925', '#fbb61a', '#fcffa4'],
  pore: ['#2b83ba', '#abdda4', '#ffffbf', '#fdae61', '#d7191c'],
  diverging: ['#2166ac', '#67a9cf', '#d1e5f0', '#f2f2f2', '#fddbc7', '#ef8a62', '#b2182b'],
  arrival: ['#fde725', '#5ec962', '#21918c', '#3b528b', '#5a2d82'],
  relief: ['#2f4a2c', '#5b6b3a', '#8a7a55', '#a89a84', '#d8d4cc'],
  intensity: ['#ffe066', '#ff9f1c', '#d62828'],
};
// grado de daño de los edificios (0 sin afectación … 4 destrucción probable)
export const DAMAGE_COLORS = ['#d9d4c7', '#ffe066', '#ff9f1c', '#e03b24', '#6b0a0a'];
export const DAMAGE_NAMES = ['Sin afectación', 'Daño leve', 'Daño moderado', 'Daño grave', 'Destrucción probable'];
export const LEVEL_COLORS = {1: '#ffe066', 2: '#ff9f1c', 3: '#d62828'};
export const CRITICALITY_COLORS = {'Crítica': '#6b0a0a', 'Alta': '#d62828', 'Media': '#ff9f1c', 'Baja': '#c9b458'};
// series de las comparaciones (distinguibles entre sí y en impresión)
export const SERIES = ['#007ac2', '#e07a1f', '#2e9e5b', '#8e44ad', '#c0392b', '#17a2b8', '#6d4c41', '#b8a000', '#5c6bc0', '#7f8c8d'];
export const hexRGB = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
