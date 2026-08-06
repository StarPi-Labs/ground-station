
import asyncio
from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic

# Nome del dispositivo da cercare (come da diagramma)
TARGET_DEVICE_NAME = "John StarPi's Rocket"

# UUID Base dall'immagine
UUID_BASE = "0e18c423-db80-{}-babb-c04dc119ef0f"

# Mappatura degli UUID delle caratteristiche con i loro nomi, basata sull'immagine
CHARACTERISTICS = {
    UUID_BASE.format("4696"): "Flight Status",
    UUID_BASE.format("4697"): "LoRa Link Status",
    UUID_BASE.format("4699"): "Attitude",
    UUID_BASE.format("469a"): "Map Position",
    UUID_BASE.format("469b"): "Acceleration",
    UUID_BASE.format("469c"): "Altitude",
    UUID_BASE.format("469d"): "Vertical Velocity",
    UUID_BASE.format("469f"): "Pressure",
    UUID_BASE.format("46a0"): "Temperature",
    UUID_BASE.format("46a2"): "Airbrake Extension"
}

def notification_handler(characteristic: BleakGATTCharacteristic, data: bytearray):
    """
    Funzione di callback chiamata ogni volta che si riceve una notifica dal dispositivo.
    """
    char_name = CHARACTERISTICS.get(characteristic.uuid, characteristic.uuid)
    
    # Molti valori nel diagramma hanno il formato di presentazione 0x19 (Stringa UTF-8).
    # Proviamo a decodificare prima come stringa.
    try:
        decoded_data = data.decode('utf-8')
        print(f"[AGGIORNAMENTO RICEVUTO 🚀] {char_name}: {decoded_data}")
    except UnicodeDecodeError:
        # Se non è una stringa valida, stampiamo i byte crudi (in formato esadecimale)
        print(f"[AGGIORNAMENTO RICEVUTO RAW ⚙️] {char_name}: {data.hex()}")

async def main():
    print("=" * 60)
    print("📡 INIZIO RICERCA BLUETOOTH...")
    print(f"🔎 Cerco il dispositivo con nome: '{TARGET_DEVICE_NAME}'")
    print("=" * 60)
    
    # Esegue la scansione cercando il nome specifico
    device = await BleakScanner.find_device_by_filter(
        lambda d, ad: d.name and d.name == TARGET_DEVICE_NAME,
        timeout=10.0
    )

    if not device:
        print("\n❌ ERRORE: Dispositivo non trovato!")
        print("💡 Suggerimento: Assicurati che il dispositivo sia acceso, in modalità 'advertising'")
        print("   (Bluetooth visibile) e sia posizionato vicino al computer.")
        return

    print(f"\n✅ DISPOSITIVO TROVATO: {device.name} (Indirizzo MAC: {device.address})")
    print("🔄 Tentativo di connessione in corso...")

    async with BleakClient(device) as client:
        if client.is_connected:
            print("\n✅ CONNESSIONE STABILITA CON SUCCESSO!")
        else:
            print("\n❌ ERRORE: Impossibile connettersi.")
            return
        
        # 1. Lettura dei valori iniziali per tutte le caratteristiche
        print("\n" + "-" * 50)
        print("📖 LETTURA DEI VALORI INIZIALI DEI SENSORI...")
        print("-" * 50)
        for char_uuid, char_name in CHARACTERISTICS.items():
            try:
                data = await client.read_gatt_char(char_uuid)
                try:
                    decoded = data.decode('utf-8')
                    print(f"  👉 [LETTURA INIZIALE] {char_name}: {decoded}")
                except UnicodeDecodeError:
                    print(f"  👉 [LETTURA INIZIALE HEX] {char_name}: {data.hex()}")
            except Exception as e:
                print(f"  ⚠️ [ERRORE LETTURA] Impossibile leggere {char_name}: {e}")

        # 2. Sottoscrizione alle notifiche
        print("\n" + "-" * 50)
        print("🔔 SOTTOSCRIZIONE ALLE NOTIFICHE IN TEMPO REALE...")
        print("-" * 50)
        for char_uuid, char_name in CHARACTERISTICS.items():
            try:
                await client.start_notify(char_uuid, notification_handler)
                print(f"  ✅ Iscritto con successo a: {char_name}")
            except Exception as e:
                print(f"  ❌ Errore di iscrizione a {char_name}: {e}")

        print("\n" + "=" * 60)
        print("🎧 IN ASCOLTO... IN ATTESA DI AGGIORNAMENTI DAI SENSORI.")
        print("Premi 'Ctrl+C' nel terminale per interrompere lo script.")
        print("=" * 60 + "\n")
        
        try:
            # Mantieni viva la connessione all'infinito per restare in ascolto
            while True:
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            pass
        except KeyboardInterrupt:
            print("\n🛑 Interruzione manuale richiesta. Disconnessione in corso...")
        finally:
            # Pulizia: scollega le notifiche prima di chiudere la connessione
            for char_uuid, char_name in CHARACTERISTICS.items():
                 try:
                     await client.stop_notify(char_uuid)
                 except Exception:
                     pass
            print("👋 Disconnesso dal dispositivo. Arrivederci!")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
