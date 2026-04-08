#!/usr/bin/env python3
"""
Rayat IoT Device Simulator
Simula un dispositivo IoT che invia dati sensori al backend Rayat
"""

import requests
import time
import random
from datetime import datetime

# Configurazione
API_URL = "http://localhost:3000/api/iot/upload"
DEVICE_ID = "RAYAT_DEVICE_001"
API_KEY = "demo_api_key_12345"
INTERVAL_SECONDS = 60  # Invia dati ogni 60 secondi

def generate_sensor_readings():
    """Genera letture sensori realistiche con variazioni"""
    return [
        {
            "type": "energia",
            "subtype": "energia_consumption",
            "value": round(2.0 + random.uniform(-0.3, 0.5), 2),
            "unit": "kW"
        },
        {
            "type": "energia",
            "subtype": "energia_daily",
            "value": round(18.0 + random.uniform(-2, 3), 1),
            "unit": "kWh"
        },
        {
            "type": "acqua",
            "subtype": "acqua_level",
            "value": round(14.0 + random.uniform(-0.5, 0.5), 2),
            "unit": "m"
        },
        {
            "type": "acqua",
            "subtype": "acqua_pressure",
            "value": round(4.0 + random.uniform(-0.3, 0.3), 1),
            "unit": "bar"
        },
        {
            "type": "terreno",
            "subtype": "terreno_moisture",
            "value": round(55 + random.uniform(-5, 10), 0),
            "unit": "%"
        },
        {
            "type": "terreno",
            "subtype": "terreno_temperature",
            "value": round(20 + random.uniform(-2, 4), 1),
            "unit": "°C"
        },
        {
            "type": "terreno",
            "subtype": "terreno_ec",
            "value": round(1.0 + random.uniform(-0.2, 0.4), 2),
            "unit": "dS/m"
        },
        {
            "type": "terreno",
            "subtype": "terreno_ph",
            "value": round(7.0 + random.uniform(-0.5, 0.5), 1),
            "unit": "pH"
        },
        {
            "type": "terreno",
            "subtype": "terreno_n",
            "value": round(100 + random.uniform(-20, 40), 0),
            "unit": "ppm"
        },
        {
            "type": "terreno",
            "subtype": "terreno_p",
            "value": round(40 + random.uniform(-10, 15), 0),
            "unit": "ppm"
        },
        {
            "type": "terreno",
            "subtype": "terreno_k",
            "value": round(160 + random.uniform(-30, 50), 0),
            "unit": "ppm"
        },
        {
            "type": "clima",
            "subtype": "clima_temperature",
            "value": round(25 + random.uniform(-5, 10), 1),
            "unit": "°C"
        },
        {
            "type": "clima",
            "subtype": "clima_humidity",
            "value": round(45 + random.uniform(-10, 15), 0),
            "unit": "%"
        },
        {
            "type": "clima",
            "subtype": "clima_wind_speed",
            "value": round(10 + random.uniform(-5, 10), 1),
            "unit": "km/h"
        }
    ]

def send_sensor_data():
    """Invia dati sensori al backend"""
    payload = {
        "device_id": DEVICE_ID,
        "api_key": API_KEY,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "readings": generate_sensor_readings()
    }
    
    try:
        response = requests.post(API_URL, json=payload, timeout=10)
        
        if response.status_code == 200:
            result = response.json()
            print(f"✅ [{datetime.now().strftime('%H:%M:%S')}] Dati inviati con successo!")
            print(f"   Letture inviate: {result.get('readings_count', 0)}")
        else:
            print(f"❌ [{datetime.now().strftime('%H:%M:%S')}] Errore: {response.status_code}")
            print(f"   Risposta: {response.text}")
            
    except requests.exceptions.ConnectionError:
        print(f"❌ [{datetime.now().strftime('%H:%M:%S')}] Impossibile connettersi al server")
        print(f"   Assicurati che il backend sia in esecuzione su {API_URL}")
    except Exception as e:
        print(f"❌ [{datetime.now().strftime('%H:%M:%S')}] Errore: {str(e)}")

def main():
    """Loop principale del simulatore"""
    print("=" * 60)
    print("🌾 Rayat IoT Device Simulator")
    print("=" * 60)
    print(f"Device ID: {DEVICE_ID}")
    print(f"API URL: {API_URL}")
    print(f"Intervallo: {INTERVAL_SECONDS} secondi")
    print("=" * 60)
    print("\nInizio invio dati... (Premi CTRL+C per fermare)\n")
    
    try:
        while True:
            send_sensor_data()
            time.sleep(INTERVAL_SECONDS)
            
    except KeyboardInterrupt:
        print("\n\n✋ Simulatore fermato dall'utente")
        print("Arrivederci! 🌾\n")

if __name__ == "__main__":
    main()
