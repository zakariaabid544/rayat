const assert = require('assert');

const { decodeModbusTelemetryFrame } = require('../utils/dtu-decoder');
const { parseSensorUpdate } = require('../utils/sensor-update-parser');

function bySubtype(readings, subtype) {
  return readings.find((reading) => reading.subtype === subtype);
}

function assertReading(readings, subtype, expectedValue, expectedType = 'terreno') {
  const reading = bySubtype(readings, subtype);
  assert.ok(reading, `Missing reading ${subtype}`);
  assert.equal(reading.type, expectedType);
  assert.equal(reading.value, expectedValue);
}

function testLegacySlaveOneClimateFrame() {
  const decoded = decodeModbusTelemetryFrame(Buffer.from('01030409550000E9BF', 'hex'));

  assert.equal(decoded.slaveId, 1);
  assert.equal(decoded.layout, 'climate_temperature_humidity');
  assert.equal(decoded.registerCount, 2);
  assert.deepEqual(decoded.registers, [2389, 0]);
  assertReading(decoded.readings, 'clima_temperature', 238.9, 'clima');
  assertReading(decoded.readings, 'clima_humidity', 0, 'clima');
}

function testGw001TwoRegisterClimateFrame() {
  const decoded = decodeModbusTelemetryFrame(Buffer.from('01030400ec02a83b18', 'hex'), { deviceId: 'GW-001' });

  assert.equal(decoded.slaveId, 1);
  assert.equal(decoded.layout, 'climate_temperature_humidity');
  assert.equal(decoded.registerCount, 2);
  assert.deepEqual(decoded.registers, [236, 680]);
  assertReading(decoded.readings, 'clima_temperature', 23.6, 'clima');
  assertReading(decoded.readings, 'clima_humidity', 68, 'clima');
}

function testGw002TwoRegisterSubstratePartialFrame() {
  const decoded = decodeModbusTelemetryFrame(Buffer.from('01030409550000E9BF', 'hex'), { deviceId: 'GW-002' });

  assert.equal(decoded.slaveId, 1);
  assert.equal(decoded.layout, 'substrate_2_register_partial');
  assert.equal(decoded.registerCount, 2);
  assert.deepEqual(decoded.registers, [2389, 0]);
  assertReading(decoded.readings, 'terreno_temperature', 23.89);
  assertReading(decoded.readings, 'terreno_moisture', 0);
}

function testSubstrateThreeRegisterFrame() {
  const decoded = decodeModbusTelemetryFrame(Buffer.from('01030609421004010C1D77', 'hex'));

  assert.equal(decoded.slaveId, 1);
  assert.equal(decoded.layout, 'substrate_3_register');
  assert.equal(decoded.registerCount, 3);
  assert.deepEqual(decoded.registers, [2370, 4100, 268]);
  assertReading(decoded.readings, 'terreno_temperature', 23.7);
  assertReading(decoded.readings, 'terreno_moisture', 41);
  assertReading(decoded.readings, 'terreno_ec', 0.268);
}

function testSubstrateInputRegisterFrame() {
  const decoded = decodeModbusTelemetryFrame(Buffer.from('01040609421004010C5C91', 'hex'));

  assert.equal(decoded.slaveId, 1);
  assert.equal(decoded.functionCode, 4);
  assert.equal(decoded.layout, 'substrate_3_register');
  assertReading(decoded.readings, 'terreno_temperature', 23.7);
  assertReading(decoded.readings, 'terreno_moisture', 41);
  assertReading(decoded.readings, 'terreno_ec', 0.268);
}

function testGw002SixRegisterPoreEcFrame() {
  const decoded = decodeModbusTelemetryFrame(Buffer.from('01030c09421004010c0000000009926871', 'hex'), { deviceId: 'GW-002' });

  assert.equal(decoded.slaveId, 1);
  assert.equal(decoded.layout, 'substrate_6_register_pore_ec');
  assert.equal(decoded.registerCount, 6);
  assert.deepEqual(decoded.registers, [2370, 4100, 268, 0, 0, 2450]);
  assertReading(decoded.readings, 'terreno_temperature', 23.7);
  assertReading(decoded.readings, 'terreno_moisture', 41);
  assertReading(decoded.readings, 'ec_substrate', 0.268);
  assertReading(decoded.readings, 'ec_root', 2.45);
  assert.equal(bySubtype(decoded.readings, 'ec_substrate').metadata.register_address, '0x0002');
  assert.equal(bySubtype(decoded.readings, 'ec_root').metadata.register_address, '0x0005');
}

function testSubstrateMqttPayloadParsing() {
  const parsed = parseSensorUpdate({
    topic: 'sensors/GW-001/telemetry',
    raw_hex: '01030609421004010C1D77'
  });

  assert.equal(parsed.deviceId, 'GW-001');
  assert.equal(parsed.readings.length, 3);
  assertReading(parsed.readings, 'terreno_temperature', 23.7);
  assertReading(parsed.readings, 'terreno_moisture', 41);
  assertReading(parsed.readings, 'terreno_ec', 0.268);
}

function testGw001TwoRegisterClimateMqttPayloadParsing() {
  const parsed = parseSensorUpdate({
    topic: 'sensors/GW-001/telemetry',
    raw_hex: '01030400ec02a83b18'
  });

  assert.equal(parsed.deviceId, 'GW-001');
  assert.equal(parsed.readings.length, 2);
  assertReading(parsed.readings, 'clima_temperature', 23.6, 'clima');
  assertReading(parsed.readings, 'clima_humidity', 68, 'clima');
  assert.equal(bySubtype(parsed.readings, 'terreno_temperature'), undefined);
}

function testGw002TwoRegisterMqttPayloadParsing() {
  const parsed = parseSensorUpdate({
    topic: 'sensors/GW-002/telemetry',
    raw_hex: '01030409550000E9BF'
  });

  assert.equal(parsed.deviceId, 'GW-002');
  assert.equal(parsed.readings.length, 2);
  assertReading(parsed.readings, 'terreno_temperature', 23.89);
  assertReading(parsed.readings, 'terreno_moisture', 0);
  assert.equal(bySubtype(parsed.readings, 'clima_temperature'), undefined);
}

function testGw002SixRegisterPoreEcMqttPayloadParsing() {
  const parsed = parseSensorUpdate({
    topic: 'sensors/GW-002/telemetry',
    raw_hex: '01030c09421004010c0000000009926871'
  });

  assert.equal(parsed.deviceId, 'GW-002');
  assert.equal(parsed.readings.length, 4);
  assertReading(parsed.readings, 'terreno_temperature', 23.7);
  assertReading(parsed.readings, 'terreno_moisture', 41);
  assertReading(parsed.readings, 'ec_substrate', 0.268);
  assertReading(parsed.readings, 'ec_root', 2.45);
  assert.equal(bySubtype(parsed.readings, 'terreno_ec'), undefined);
}

function testLegacySevenInOneSoilFrame() {
  const decoded = decodeModbusTelemetryFrame(Buffer.from('03030E00F0022604D200B4002D0104028A1F8C', 'hex'));

  assert.equal(decoded.slaveId, 3);
  assert.equal(decoded.layout, 'soil_7_in_1');
  assert.equal(decoded.registerCount, 7);
  assertReading(decoded.readings, 'terreno_temperature', 24);
  assertReading(decoded.readings, 'terreno_moisture', 55);
  assertReading(decoded.readings, 'terreno_ec', 1.234);
  assertReading(decoded.readings, 'terreno_n', 180);
  assertReading(decoded.readings, 'terreno_p', 45);
  assertReading(decoded.readings, 'terreno_k', 260);
  assertReading(decoded.readings, 'terreno_ph', 6.5);
}

testLegacySlaveOneClimateFrame();
testGw001TwoRegisterClimateFrame();
testGw002TwoRegisterSubstratePartialFrame();
testSubstrateThreeRegisterFrame();
testSubstrateInputRegisterFrame();
testGw002SixRegisterPoreEcFrame();
testSubstrateMqttPayloadParsing();
testGw001TwoRegisterClimateMqttPayloadParsing();
testGw002TwoRegisterMqttPayloadParsing();
testGw002SixRegisterPoreEcMqttPayloadParsing();
testLegacySevenInOneSoilFrame();

console.log('DTU decoder tests passed');
