#!/bin/bash
set -euo pipefail

cd /home/paperclip/despacho/lexpanel
npm run build
sudo mkdir -p /var/www/lexpanel/
sudo cp -r bff-dist/* /var/www/lexpanel/
echo "Deploy completado"
