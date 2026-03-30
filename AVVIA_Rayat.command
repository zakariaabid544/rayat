#!/bin/bash
# Rayat Auto Launch Script

# Get the directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR/backend"

# Assicuriamoci che i comandi di base e Node.js siano trovati
export PATH=$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/v*/bin

# Carica il profilo utente nel caso ci siano altre path
source ~/.bash_profile 2>/dev/null || true
source ~/.zshrc 2>/dev/null || true
source ~/.zprofile 2>/dev/null || true

echo "------------------------------------------------"
echo "🚀 AVVIO CONFIGURAZIONE RAYAT..."
echo "------------------------------------------------"

if [ ! -d "node_modules" ]; then
    echo "📦 Installazione moduli (solo la prima volta)..."
    npm install --no-fund --no-audit || true
fi

# Se MAMP è in esecuzione, prepariamo il database automaticamente usando i comandi MAMP
if [ -f "/Applications/MAMP/Library/bin/mysql" ]; then
    echo "🗄️ Inizializzazione Database MAMP..."
    /Applications/MAMP/Library/bin/mysql -u root -proot -h 127.0.0.1 -P 8889 -e "CREATE DATABASE IF NOT EXISTS rayat_db;" 2>/dev/null || true
    /Applications/MAMP/Library/bin/mysql -u root -proot -h 127.0.0.1 -P 8889 rayat_db < ../database/schema.sql 2>/dev/null || true
fi

# Run the setup and start server
node start.js || /usr/local/bin/node start.js || /opt/homebrew/bin/node start.js

echo ""
echo "Premi un tasto per chiudere..."
read -n 1
