# LexPanel

Panel interno para el despacho, construido con React + Vite + Tailwind CSS.

## Requisitos

- Node.js 20+
- Acceso de lectura a la API de Paperclip

## Setup

```bash
npm install
cp .env.example .env
```

Completa `VITE_PAPERCLIP_API_KEY` en `.env`.

## Desarrollo

```bash
npm run dev
```

- URL local: `http://localhost:8090`
- Polling: cada 30 segundos

## Build de producción

```bash
npm run build
```

El artefacto final queda en `dist/` listo para servir con nginx.

## Deploy local (build + copy)

Se incluye un script de despliegue local en `deploy.sh`:

```bash
chmod +x deploy.sh
./deploy.sh
```

Este script:
- ejecuta `npm run build`
- copia `dist/*` a `/var/www/lexpanel/` (requiere `sudo`)

## Configuración nginx para `app.lexreclama.es`

El virtual host solicitado está en `nginx.conf`:

```nginx
server {
    listen 80;
    server_name app.lexreclama.es;
    root /var/www/lexpanel;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### Pasos para el board (servidor `162.55.176.36`)

1. Copiar `nginx.conf` al servidor.
2. Guardarlo como `/etc/nginx/sites-available/lexpanel.conf`.
3. Activarlo:

```bash
sudo ln -s /etc/nginx/sites-available/lexpanel.conf /etc/nginx/sites-enabled/lexpanel.conf
sudo nginx -t
sudo systemctl reload nginx
```

## GitHub repo (LexIAW3/lexpanel)

No hay credenciales GitHub disponibles en este entorno, así que estos pasos los debe ejecutar el board:

1. Crear repo privado en la organización `LexIAW3` con nombre `lexpanel`.
2. Desde este directorio (`/home/paperclip/despacho/lexpanel`), inicializar y subir código:

```bash
git init
git add .
git commit -m "Initial LexPanel app"
git branch -M main
git remote add origin git@github.com:LexIAW3/lexpanel.git
git push -u origin main
```

Si prefieren HTTPS:

```bash
git remote add origin https://github.com/LexIAW3/lexpanel.git
git push -u origin main
```

## Funcionalidades

- Login simple con credenciales de entorno (`VITE_ADMIN_USER`, `VITE_ADMIN_PASSWORD`)
- Dashboard de casos con filtros por estado legal
- Ficha de caso con datos de cliente, importes, documentos e historial de comentarios
- Integración de solo lectura con la API REST de Paperclip
