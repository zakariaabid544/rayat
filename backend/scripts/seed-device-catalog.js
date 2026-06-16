/**
 * Seeds the Phase 2 Device Manager catalogs.
 *
 * Manual use:
 *   npm run seed:device-catalog
 *
 * This script is idempotent and is not run automatically by the server.
 */
require('../config/env');

const { query } = require('../config/database');
const { ensurePlatformSchema } = require('../utils/platform-schema');

function register(hex, int, source = 'confirmed') {
  return { hex, int, source };
}

function todoRegister() {
  return { hex: null, int: null, source: 'TODO: confermare' };
}

function label(it, fr, en, ar) {
  return { it, fr, en, ar };
}

function parameter({
  key,
  register: registerDefinition,
  type,
  subtype,
  label: labels,
  unit,
  scale,
  signed = false,
  enabled = true,
  order
}) {
  return {
    key,
    register: registerDefinition,
    type,
    subtype,
    label: labels,
    unit,
    scale,
    signed,
    enabled,
    order
  };
}

const SENSOR_MODELS = [
  {
    slug: 'bgt-sec-z4-perlite',
    version: '1',
    name: 'BGT-SEC(Z4) Perlite',
    manufacturer: 'BGT',
    primary_type: 'terreno',
    labels: label('BGT-SEC(Z4) Perlite', 'BGT-SEC(Z4) Perlite', 'BGT-SEC(Z4) Perlite', 'BGT-SEC(Z4) بيرلايت'),
    notes: 'Rispecchia il layout live substrate_6_register_pore_ec: registri confermati 0x0000, 0x0001, 0x0002, 0x0005.',
    parameters: [
      parameter({
        key: 'substrate_temperature',
        register: register('0x0000', 0),
        type: 'terreno',
        subtype: 'terreno_temperature',
        label: label('Temperatura substrato', 'Temperature substrat', 'Substrate temperature', 'درجة حرارة الركيزة'),
        unit: '°C',
        scale: 0.01,
        signed: true,
        order: 1
      }),
      parameter({
        key: 'substrate_moisture',
        register: register('0x0001', 1),
        type: 'terreno',
        subtype: 'terreno_moisture',
        label: label('Umidita substrato', 'Humidite substrat', 'Substrate moisture', 'رطوبة الركيزة'),
        unit: '%',
        scale: 0.01,
        order: 2
      }),
      parameter({
        key: 'ec_substrate',
        register: register('0x0002', 2),
        type: 'terreno',
        subtype: 'ec_substrate',
        label: label('EC substrato', 'EC Substrat', 'Bulk EC', 'ملوحة الركيزة'),
        unit: 'dS/m',
        scale: 0.001,
        order: 3
      }),
      parameter({
        key: 'ec_root',
        register: register('0x0005', 5),
        type: 'terreno',
        subtype: 'ec_root',
        label: label('EC racinaire', 'EC Racinaire', 'Pore EC', 'ملوحة منطقة الجذور'),
        unit: 'dS/m',
        scale: 0.001,
        order: 4
      })
    ]
  },
  {
    slug: 'soil-7-in-1-rs485',
    version: '1',
    name: 'Suolo 7-in-1 RS485',
    manufacturer: null,
    primary_type: 'terreno',
    labels: label('Suolo 7-in-1 RS485', 'Sol 7-en-1 RS485', 'Soil 7-in-1 RS485', 'تربة 7 في 1 RS485'),
    notes: 'Registri da confermare prima di usare questo modello per decodifica live.',
    parameters: [
      parameter({
        key: 'soil_moisture',
        register: todoRegister(),
        type: 'terreno',
        subtype: 'terreno_moisture',
        label: label('Umidita suolo', 'Humidite sol', 'Soil moisture', 'رطوبة التربة'),
        unit: '%',
        scale: 0.1,
        order: 1
      }),
      parameter({
        key: 'soil_temperature',
        register: todoRegister(),
        type: 'terreno',
        subtype: 'terreno_temperature',
        label: label('Temperatura suolo', 'Temperature sol', 'Soil temperature', 'درجة حرارة التربة'),
        unit: '°C',
        scale: 0.1,
        signed: true,
        order: 2
      }),
      parameter({
        key: 'soil_ec',
        register: todoRegister(),
        type: 'terreno',
        subtype: 'terreno_ec',
        label: label('EC suolo', 'EC sol', 'Soil EC', 'ملوحة التربة'),
        unit: 'dS/m',
        scale: 0.001,
        order: 3
      }),
      parameter({
        key: 'soil_ph',
        register: todoRegister(),
        type: 'terreno',
        subtype: 'terreno_ph',
        label: label('pH suolo', 'pH sol', 'Soil pH', 'حموضة التربة'),
        unit: 'pH',
        scale: 0.01,
        order: 4
      }),
      parameter({
        key: 'soil_n',
        register: todoRegister(),
        type: 'terreno',
        subtype: 'terreno_n',
        label: label('Azoto', 'Azote', 'Nitrogen', 'النيتروجين'),
        unit: 'ppm',
        scale: 1,
        order: 5
      }),
      parameter({
        key: 'soil_p',
        register: todoRegister(),
        type: 'terreno',
        subtype: 'terreno_p',
        label: label('Fosforo', 'Phosphore', 'Phosphorus', 'الفوسفور'),
        unit: 'ppm',
        scale: 1,
        order: 6
      }),
      parameter({
        key: 'soil_k',
        register: todoRegister(),
        type: 'terreno',
        subtype: 'terreno_k',
        label: label('Potassio', 'Potassium', 'Potassium', 'البوتاسيوم'),
        unit: 'ppm',
        scale: 1,
        order: 7
      })
    ]
  },
  {
    slug: 'ambient-co2',
    version: '1',
    name: 'CO2 ambiente',
    manufacturer: null,
    primary_type: 'clima',
    labels: label('CO2 ambiente', 'CO2 ambiant', 'Ambient CO2', 'ثاني أكسيد الكربون'),
    notes: 'Registro non documentato nel catalogo iniziale.',
    parameters: [
      parameter({
        key: 'ambient_co2',
        register: todoRegister(),
        type: 'clima',
        subtype: 'clima_co2',
        label: label('CO2 ambiente', 'CO2 ambiant', 'Ambient CO2', 'ثاني أكسيد الكربون'),
        unit: 'ppm',
        scale: 1,
        order: 1
      })
    ]
  },
  {
    slug: 'ambient-temperature-humidity',
    version: '1',
    name: 'Clima/umidita ambiente',
    manufacturer: null,
    primary_type: 'clima',
    labels: label('Clima/umidita ambiente', 'Temperature/humidite ambiante', 'Ambient temperature/humidity', 'حرارة ورطوبة الجو'),
    notes: 'Registri non documentati nel catalogo iniziale.',
    parameters: [
      parameter({
        key: 'ambient_temperature',
        register: todoRegister(),
        type: 'clima',
        subtype: 'clima_temperature',
        label: label('Temperatura ambiente', 'Temperature ambiante', 'Ambient temperature', 'درجة حرارة الجو'),
        unit: '°C',
        scale: 0.1,
        signed: true,
        order: 1
      }),
      parameter({
        key: 'ambient_humidity',
        register: todoRegister(),
        type: 'clima',
        subtype: 'clima_humidity',
        label: label('Umidita ambiente', 'Humidite ambiante', 'Ambient humidity', 'رطوبة الجو'),
        unit: '%',
        scale: 0.1,
        order: 2
      })
    ]
  }
];

const CROP_PROFILES = [
  {
    slug: 'tomato-perlite',
    version: '1',
    crop_key: 'tomato',
    medium: 'perlite',
    labels: label('Pomodoro in perlite', 'Tomate en perlite', 'Tomato in perlite', 'طماطم في البيرلايت'),
    description: {
      it: 'Profilo iniziale per pomodoro fuori suolo in perlite.',
      fr: 'Profil initial pour tomate hors-sol en perlite.',
      en: 'Initial profile for soilless tomato in perlite.',
      ar: 'ملف أولي للطماطم في البيرلايت.'
    },
    ranges: {
      ec_root: { min: 2.0, max: 3.5, unit: 'dS/m' },
      ec_substrate: { min: 0.5, max: 2.0, unit: 'dS/m' },
      terreno_temperature: { min: 18, max: 26, unit: '°C' },
      terreno_moisture: { min: 55, max: 75, unit: '%' }
    }
  },
  {
    slug: 'banana',
    version: '1',
    crop_key: 'banana',
    medium: 'soil',
    labels: label('Banana', 'Banane', 'Banana', 'موز'),
    description: {
      it: 'ASSUNZIONE da validare: profilo iniziale per banana in suolo.',
      fr: 'HYPOTHESE a valider: profil initial pour banane en sol.',
      en: 'ASSUMPTION to validate: initial profile for banana in soil.',
      ar: 'افتراض يحتاج إلى تحقق: ملف أولي للموز في التربة.'
    },
    ranges: {
      terreno_temperature: { min: 20, max: 30, unit: '°C' },
      terreno_moisture: { min: 60, max: 85, unit: '%' },
      terreno_ec: { min: 0.8, max: 2.0, unit: 'dS/m' },
      clima_temperature: { min: 22, max: 32, unit: '°C' },
      clima_humidity: { min: 60, max: 90, unit: '%' }
    }
  },
  {
    slug: 'olive',
    version: '1',
    crop_key: 'olive',
    medium: 'soil',
    labels: label('Olivo', 'Olivier', 'Olive', 'زيتون'),
    description: {
      it: 'ASSUNZIONE da validare: profilo iniziale per olivo.',
      fr: 'HYPOTHESE a valider: profil initial pour olivier.',
      en: 'ASSUMPTION to validate: initial profile for olive trees.',
      ar: 'افتراض يحتاج إلى تحقق: ملف أولي لأشجار الزيتون.'
    },
    ranges: {
      terreno_temperature: { min: 12, max: 28, unit: '°C' },
      terreno_moisture: { min: 25, max: 55, unit: '%' },
      terreno_ec: { min: 0.5, max: 2.5, unit: 'dS/m' },
      clima_temperature: { min: 10, max: 35, unit: '°C' }
    }
  },
  {
    slug: 'custom',
    version: '1',
    crop_key: 'custom',
    medium: null,
    labels: label('Coltura personalizzata', 'Culture personnalisee', 'Custom crop', 'محصول مخصص'),
    description: {
      it: 'Profilo libero configurabile dal Super Admin.',
      fr: 'Profil libre configurable par Super Admin.',
      en: 'Free profile configurable by Super Admin.',
      ar: 'ملف حر قابل للتكوين من طرف المدير.'
    },
    ranges: {}
  }
];

async function insertSensorModel(model) {
  await query(
    `INSERT INTO sensor_models (
       slug,
       version,
       name,
       manufacturer,
       primary_type,
       labels,
       parameters,
       notes,
       active,
       created_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, TRUE, NOW(), NOW())
     ON CONFLICT (slug, version) DO NOTHING`,
    [
      model.slug,
      model.version,
      model.name,
      model.manufacturer,
      model.primary_type,
      JSON.stringify(model.labels),
      JSON.stringify(model.parameters),
      model.notes
    ]
  );
}

async function insertCropProfile(profile) {
  await query(
    `INSERT INTO crop_profiles (
       slug,
       version,
       crop_key,
       medium,
       labels,
       description,
       ranges,
       active,
       created_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, TRUE, NOW(), NOW())
     ON CONFLICT (slug, version) DO NOTHING`,
    [
      profile.slug,
      profile.version,
      profile.crop_key,
      profile.medium,
      JSON.stringify(profile.labels),
      JSON.stringify(profile.description),
      JSON.stringify(profile.ranges)
    ]
  );
}

async function seedDeviceCatalog() {
  await ensurePlatformSchema();

  for (const model of SENSOR_MODELS) {
    await insertSensorModel(model);
    console.log(`Ensured sensor model ${model.slug}@${model.version}`);
  }

  for (const profile of CROP_PROFILES) {
    await insertCropProfile(profile);
    console.log(`Ensured crop profile ${profile.slug}@${profile.version}`);
  }
}

seedDeviceCatalog()
  .then(() => {
    console.log('Device catalog seed completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Device catalog seed failed:', error.message);
    process.exit(1);
  });
