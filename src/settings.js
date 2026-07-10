// Car setup: slider values are multipliers (1 = stock), stored with presets
// in localStorage. Built-in presets can't be deleted or overwritten.
const STORAGE_KEY = 'fablerace.settings.v1';

export const SLIDERS = [
  { key: 'power', label: 'Мощность двигателя', min: 0.5, max: 1.5 },
  { key: 'aero',  label: 'Аэродинамика (макс. скорость)', min: 0.7, max: 1.3 },
  { key: 'steer', label: 'Острота руля', min: 0.5, max: 1.5 },
  { key: 'grip',  label: 'Сцепление шин', min: 0.6, max: 1.4 },
];

const BUILTIN_PRESETS = {
  'Стандарт': { power: 1, aero: 1, steer: 1, grip: 1 },
  'Новичок': { power: 0.7, aero: 0.9, steer: 0.85, grip: 1.3 },
  'Спорт': { power: 1.3, aero: 1.15, steer: 1.15, grip: 1.1 },
  'Дрифт': { power: 1.1, aero: 1, steer: 1.25, grip: 0.65 },
};
const CUSTOM = '— своя настройка —';

export class Settings {
  constructor() {
    this.values = { ...BUILTIN_PRESETS['Стандарт'] };
    this.userPresets = {};
    this.activePreset = 'Стандарт';
    this.onChange = null;
    this._load();
    this._bindUI();
    this._refreshUI();
  }

  _load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (raw) {
        if (raw.values) this.values = { ...this.values, ...raw.values };
        if (raw.userPresets) this.userPresets = raw.userPresets;
        if (raw.activePreset) this.activePreset = raw.activePreset;
      }
    } catch { /* corrupted storage — start fresh */ }
  }

  _save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      values: this.values,
      userPresets: this.userPresets,
      activePreset: this.activePreset,
    }));
  }

  _allPresets() {
    return { ...BUILTIN_PRESETS, ...this.userPresets };
  }

  _emit() {
    this._save();
    if (this.onChange) this.onChange(this.values);
  }

  _bindUI() {
    this.el = {
      select: document.getElementById('preset-select'),
      del: document.getElementById('preset-delete'),
      name: document.getElementById('preset-name'),
      save: document.getElementById('preset-save'),
      sliders: {},
      outputs: {},
    };
    const box = document.getElementById('sliders');
    for (const s of SLIDERS) {
      const row = document.createElement('div');
      row.className = 'slider-row';
      const label = document.createElement('label');
      label.textContent = s.label;
      const out = document.createElement('span');
      out.className = 'slider-val';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = Math.round(s.min * 100);
      input.max = Math.round(s.max * 100);
      input.step = 5;
      input.addEventListener('input', () => {
        this.values[s.key] = input.value / 100;
        this.activePreset = CUSTOM;
        this._refreshUI();
        this._emit();
      });
      const top = document.createElement('div');
      top.className = 'slider-top';
      top.append(label, out);
      row.append(top, input);
      box.append(row);
      this.el.sliders[s.key] = input;
      this.el.outputs[s.key] = out;
    }

    this.el.select.addEventListener('change', () => {
      const name = this.el.select.value;
      const preset = this._allPresets()[name];
      if (preset) {
        this.values = { ...preset };
        this.activePreset = name;
        this._refreshUI();
        this._emit();
      }
    });

    this.el.save.addEventListener('click', () => {
      const name = this.el.name.value.trim();
      if (!name || BUILTIN_PRESETS[name]) return;
      this.userPresets[name] = { ...this.values };
      this.activePreset = name;
      this.el.name.value = '';
      this._refreshUI();
      this._emit();
    });

    this.el.del.addEventListener('click', () => {
      if (this.userPresets[this.activePreset]) {
        delete this.userPresets[this.activePreset];
        this.activePreset = 'Стандарт';
        this.values = { ...BUILTIN_PRESETS['Стандарт'] };
        this._refreshUI();
        this._emit();
      }
    });
  }

  _refreshUI() {
    for (const s of SLIDERS) {
      this.el.sliders[s.key].value = Math.round(this.values[s.key] * 100);
      this.el.outputs[s.key].textContent = `${Math.round(this.values[s.key] * 100)}%`;
    }
    const names = [...Object.keys(BUILTIN_PRESETS), ...Object.keys(this.userPresets)];
    this.el.select.innerHTML = '';
    for (const n of names) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = n;
      this.el.select.append(opt);
    }
    if (this.activePreset === CUSTOM) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = CUSTOM;
      this.el.select.append(opt);
    }
    this.el.select.value = this.activePreset;
    // deleting makes sense only for the user's own presets
    this.el.del.style.visibility = this.userPresets[this.activePreset] ? 'visible' : 'hidden';
  }
}
