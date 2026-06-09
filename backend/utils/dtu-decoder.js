function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHex(value) {
    const normalized = cleanString(value).replace(/\s+/g, '').toLowerCase();
    if (!normalized || !/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
        return '';
    }
    return normalized;
}

function extractRawEnvelope(source = {}) {
    if (!isPlainObject(source)) {
        return null;
    }

    const rawHex = normalizeHex(
        source.raw_hex
        || source.rawHex
        || source.payload_hex
        || source.payloadHex
        || source.value_hex
        || source.valueHex
    );
    const rawBase64 = cleanString(
        source.raw_base64
        || source.rawBase64
        || source.payload_base64
        || source.payloadBase64
        || source.value_base64
        || source.valueBase64
    );

    if (!rawHex && !rawBase64) {
        return null;
    }

    return {
        rawHex,
        rawBase64,
        payloadEncoding: cleanString(source.payload_encoding || source.payloadEncoding || source.format || source.type_hint)
    };
}

function bufferFromEnvelope(envelope) {
    if (!envelope) {
        return null;
    }

    if (envelope.rawHex) {
        return Buffer.from(envelope.rawHex, 'hex');
    }

    if (envelope.rawBase64) {
        return Buffer.from(envelope.rawBase64, 'base64');
    }

    return null;
}

function computeModbusCrc(buffer) {
    let crc = 0xFFFF;

    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            if (crc & 0x0001) {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }

    return crc & 0xFFFF;
}

function readSignedRegister(value) {
    return value > 0x7FFF ? value - 0x10000 : value;
}

const SUBSTRATE_3_REGISTER_LAYOUT = {
    name: 'substrate_3_register',
    readings: [
        {
            type: 'terreno',
            subtype: 'terreno_temperature',
            name: 'Sensore Temperatura Substrato',
            unit: '°C',
            scale: 0.01,
            signed: true
        },
        {
            type: 'terreno',
            subtype: 'terreno_moisture',
            name: 'Sensore Umidita Substrato',
            unit: '%',
            scale: 0.01
        },
        {
            type: 'terreno',
            subtype: 'terreno_ec',
            name: 'Sensore EC Substrato',
            unit: 'dS/m',
            scale: 0.001
        }
    ]
};

const SUBSTRATE_2_REGISTER_PARTIAL_LAYOUT = {
    name: 'substrate_2_register_partial',
    readings: [
        {
            type: 'terreno',
            subtype: 'terreno_temperature',
            name: 'Sensore Temperatura Substrato',
            unit: '°C',
            scale: 0.01,
            signed: true
        },
        {
            type: 'terreno',
            subtype: 'terreno_moisture',
            name: 'Sensore Umidita Substrato',
            unit: '%',
            scale: 0.01
        }
    ]
};

const SUBSTRATE_DEVICE_IDS = new Set(['GW-001', 'RAYAT-GW-001']);

const FRAME_LAYOUTS = {
    1: {
        2: {
            name: 'climate_temperature_humidity',
            readings: [
                {
                    type: 'clima',
                    subtype: 'clima_temperature',
                    name: 'Sensore Temperatura',
                    unit: '°C',
                    scale: 0.1,
                    signed: true
                },
                {
                    type: 'clima',
                    subtype: 'clima_humidity',
                    name: 'Sensore Umidita',
                    unit: '%',
                    scale: 0.1
                }
            ]
        },
        3: SUBSTRATE_3_REGISTER_LAYOUT
    },
    2: {
        1: {
            name: 'climate_co2',
            readings: [
                {
                    type: 'clima',
                    subtype: 'clima_co2',
                    name: 'Sensore CO2',
                    unit: 'ppm',
                    scale: 1
                }
            ]
        }
    },
    3: {
        3: SUBSTRATE_3_REGISTER_LAYOUT,
        7: {
            name: 'soil_7_in_1',
            readings: [
                {
                    type: 'terreno',
                    subtype: 'terreno_temperature',
                    name: 'Sensore Temperatura Terreno',
                    unit: '°C',
                    scale: 0.1,
                    signed: true
                },
                {
                    type: 'terreno',
                    subtype: 'terreno_moisture',
                    name: 'Sensore Umidita Terreno',
                    unit: '%',
                    scale: 0.1
                },
                {
                    type: 'terreno',
                    subtype: 'terreno_ec',
                    name: 'Sensore EC Terreno',
                    unit: 'dS/m',
                    scale: 0.001
                },
                {
                    type: 'terreno',
                    subtype: 'terreno_n',
                    name: 'Sensore Azoto',
                    unit: 'ppm',
                    scale: 1
                },
                {
                    type: 'terreno',
                    subtype: 'terreno_p',
                    name: 'Sensore Fosforo',
                    unit: 'ppm',
                    scale: 1
                },
                {
                    type: 'terreno',
                    subtype: 'terreno_k',
                    name: 'Sensore Potassio',
                    unit: 'ppm',
                    scale: 1
                },
                {
                    type: 'terreno',
                    subtype: 'terreno_ph',
                    name: 'Sensore pH Terreno',
                    unit: 'pH',
                    scale: 0.01
                }
            ]
        }
    }
};

function normalizeDeviceId(value) {
    return cleanString(value).toUpperCase();
}

function shouldUseSubstrateLayout(options = {}) {
    const profile = cleanString(options.sensorProfile || options.profile).toLowerCase();
    return profile === 'substrate'
        || profile === 'perlite'
        || SUBSTRATE_DEVICE_IDS.has(normalizeDeviceId(options.deviceId || options.device_id));
}

function resolveFrameLayout(slaveId, registerCount, options = {}) {
    if (slaveId === 1 && registerCount === 2 && shouldUseSubstrateLayout(options)) {
        return SUBSTRATE_2_REGISTER_PARTIAL_LAYOUT;
    }

    return FRAME_LAYOUTS[slaveId]?.[registerCount];
}

function decodeModbusTelemetryFrame(buffer, options = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
        throw new Error('Frame Modbus troppo corto');
    }

    const slaveId = buffer[0];
    const functionCode = buffer[1];
    const byteCount = buffer[2];
    const expectedLength = 3 + byteCount + 2;

    if (functionCode !== 0x03 && functionCode !== 0x04) {
        throw new Error(`Function code Modbus non supportato: ${functionCode}`);
    }

    if (buffer.length !== expectedLength) {
        throw new Error(`Lunghezza frame non valida: attesa ${expectedLength}, ricevuta ${buffer.length}`);
    }

    const payload = buffer.subarray(0, -2);
    const expectedCrc = computeModbusCrc(payload);
    const receivedCrc = buffer.readUInt16LE(buffer.length - 2);

    if (expectedCrc !== receivedCrc) {
        throw new Error(`CRC non valido per lo slave ${slaveId}`);
    }

    const registerCount = byteCount / 2;
    const layout = resolveFrameLayout(slaveId, registerCount, options);
    if (!layout) {
        const supportedCounts = Object.keys(FRAME_LAYOUTS[slaveId] || {}).join(', ');
        throw new Error(
            supportedCounts
                ? `Numero registri inatteso per lo slave ${slaveId}: ${registerCount}. Attesi: ${supportedCounts}`
                : `Slave Modbus non supportato: ${slaveId}`
        );
    }

    const registers = [];
    for (let offset = 3; offset < buffer.length - 2; offset += 2) {
        registers.push(buffer.readUInt16BE(offset));
    }

    const readings = layout.readings.map((definition, index) => {
        const rawValue = registers[index];
        const sourceValue = definition.signed ? readSignedRegister(rawValue) : rawValue;
        const value = Number((sourceValue * definition.scale).toFixed(definition.scale < 1 ? 3 : 0));

        return {
            type: definition.type,
            subtype: definition.subtype,
            name: definition.name,
            unit: definition.unit,
            value,
            metadata: {
                protocol: 'modbus_rtu',
                slave_id: slaveId,
                function_code: functionCode,
                layout: layout.name,
                register_index: index,
                raw_register: rawValue
            }
        };
    });

    return {
        protocol: 'modbus_rtu',
        slaveId,
        functionCode,
        layout: layout.name,
        registerCount: registers.length,
        registers,
        rawHex: buffer.toString('hex'),
        readings
    };
}

module.exports = {
    extractRawEnvelope,
    bufferFromEnvelope,
    decodeModbusTelemetryFrame
};
