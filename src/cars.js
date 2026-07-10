import { asset } from './asset.js';

// Car roster. Each profile multiplies the base physics (1 = the stock car
// the game was tuned around). Balanced so no car dominates: strong straights
// cost cornering, and vice versa.
export const CARS = [
  {
    id: 'race',
    model: asset('models/race.glb'),
    name: 'Болид',
    blurb: 'Классика трека: быстрый и честный.',
    length: 4.2,
    profile: { power: 1.1, aero: 1.12, steer: 1.0, grip: 1.0 },
  },
  {
    id: 'race-future',
    model: asset('models/race-future.glb'),
    name: 'Прототип',
    blurb: 'Ракета на прямых, упрямый в поворотах.',
    length: 4.5,
    profile: { power: 1.3, aero: 1.22, steer: 0.8, grip: 0.85 },
  },
  {
    id: 'sedan-sports',
    model: asset('models/sedan-sports.glb'),
    name: 'Спорт-седан',
    blurb: 'Цепкий универсал: прощает ошибки.',
    length: 4.3,
    profile: { power: 0.95, aero: 1.0, steer: 1.1, grip: 1.2 },
  },
  {
    id: 'hatchback-sports',
    model: asset('models/hatchback-sports.glb'),
    name: 'Хот-хэтч',
    blurb: 'Вертлявый и скользкий — для любителей дрифта.',
    length: 3.9,
    profile: { power: 1.0, aero: 0.9, steer: 1.3, grip: 0.8 },
  },
  {
    id: 'kart',
    model: asset('models/kart-ooli.glb'),
    name: 'Карт',
    blurb: 'Король поворотов, черепаха на прямых.',
    length: 2.4,
    profile: { power: 0.72, aero: 0.78, steer: 1.45, grip: 1.35 },
  },
];

// 0..1 stat bars for the menu cards.
export function carStats(car) {
  const p = car.profile;
  const clamp01 = (x) => Math.min(1, Math.max(0.05, x));
  return {
    'Скорость': clamp01((p.power * p.aero - 0.55) / 1.05),
    'Управляемость': clamp01((p.steer - 0.6) / 0.9),
    'Сцепление': clamp01((p.grip - 0.6) / 0.85),
  };
}
