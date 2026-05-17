#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Dental Clinic – Cloud Server Setup Script
#  Run this on a fresh Ubuntu 22.04 / 24.04 VPS (DigitalOcean, AWS, etc.)
#
#  Usage:
#    1. Upload your project folder to the server:
#         scp -r "Dental_Clinic_webapp" root@YOUR_SERVER_IP:/opt/dental
#    2. SSH into the server:
#         ssh root@YOUR_SERVER_IP
#    3. Run this script:
#         cd /opt/dental && bash deploy-cloud.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

APP_DIR="/opt/dental"
APP_PORT=3000
DOMAIN=""          # Set to your domain e.g. "clinic.example.com" (leave empty for IP-only)
APP_USER="dental"

echo ""
echo "==================================================="
echo "  Dental Clinic — Cloud Deployment"
echo "==================================================="
echo ""

# ── 1. System update ─────────────────────────────────────────────────────────
echo "[1/7] Updating system..."
apt-get update -qq && apt-get upgrade -y -qq

# ── 2. Node.js 22 LTS ────────────────────────────────────────────────────────
echo "[2/7] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - -qq
apt-get install -y nodejs -qq
echo "      Node $(node -v) ready"

# ── 3. PM2 process manager ───────────────────────────────────────────────────
echo "[3/7] Installing PM2 (keeps app running after reboot)..."
npm install -g pm2 -q

# ── 4. App dependencies ───────────────────────────────────────────────────────
echo "[4/7] Installing app dependencies..."
cd "$APP_DIR"
npm install --save-exact -q
node -e "require('./db')" 2>/dev/null   # initialise DB
echo "      Dependencies and database ready"

# ── 5. Start app with PM2 ────────────────────────────────────────────────────
echo "[5/7] Starting app with PM2..."
pm2 delete dental-clinic 2>/dev/null || true
pm2 start server.js --name dental-clinic --env production
pm2 save
pm2 startup | tail -1 | bash  # auto-start on server reboot
echo "      App running on port $APP_PORT"

# ── 6. Nginx reverse proxy (optional but recommended) ────────────────────────
echo "[6/7] Installing Nginx..."
apt-get install -y nginx -qq

# Write Nginx config
if [ -n "$DOMAIN" ]; then
    SERVER_NAME="$DOMAIN www.$DOMAIN"
else
    SERVER_NAME="_"   # respond to any IP
fi

cat > /etc/nginx/sites-available/dental << EOF
server {
    listen 80;
    server_name $SERVER_NAME;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";

    location / {
        proxy_pass         http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_cache_bypass \$http_upgrade;
        client_max_body_size 50M;
    }
}
EOF

ln -sf /etc/nginx/sites-available/dental /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "      Nginx configured — app accessible on port 80"

# ── 7. UFW Firewall ───────────────────────────────────────────────────────────
echo "[7/7] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
echo "      Firewall enabled (SSH + HTTP/HTTPS open)"

# ── Optional: Free SSL certificate (requires a domain) ───────────────────────
if [ -n "$DOMAIN" ]; then
    echo ""
    echo "  Installing free SSL certificate for $DOMAIN..."
    apt-get install -y certbot python3-certbot-nginx -qq
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" || \
        echo "  [WARN] SSL setup failed — make sure DNS points to this server first."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
echo "==================================================="
echo "  Deployment Complete!"
echo "==================================================="
echo ""
echo "  Access the app at:"
if [ -n "$DOMAIN" ]; then
echo "    https://$DOMAIN"
fi
echo "    http://$SERVER_IP"
echo ""
echo "  Useful PM2 commands:"
echo "    pm2 status             — check if app is running"
echo "    pm2 logs dental-clinic — view live logs"
echo "    pm2 restart dental-clinic"
echo ""
echo "  Database backup:"
echo "    cp $APP_DIR/database/dental.db ~/dental-backup-\$(date +%Y%m%d).db"
echo ""
