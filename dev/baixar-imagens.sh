#!/usr/bin/env bash
# Baixa as artes e fotos usadas nas fixtures para dev/img (fora do git). Requer gws, ffmpeg e Pillow.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p raw img; cd raw
for id in $(node ../modelo.js); do
  [ -f "$id" ] || gws drive files get --params "{\"fileId\":\"$id\",\"alt\":\"media\"}" --output "$id" >/dev/null 2>>../gws.err || echo "falhou $id"
  if file "$id" | grep -qi 'mp4\|iso media'; then ffmpeg -loglevel error -y -ss 2 -i "$id" -frames:v 1 "$id.png" && mv "$id.png" "$id"; fi
done
python3 -c "
from PIL import Image;import os
for f in os.listdir('.'):
    im=Image.open(f).convert('RGB');im.thumbnail((700,1000));im.save('../img/'+f+'.jpg',quality=78)"
