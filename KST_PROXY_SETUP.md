# kst2you
An alternative interface to KST chat

## Adding a Proxy Server to Support This Site

Follow these steps to set up a proxy server to support the KST2You interface:

### 1. Install Python 3 and pip
If Python 3 and pip are not installed on your system, install them using the following command:

```bash
sudo yum install python3 pip
```

### 2. Install Websockify
Install Websockify using pip:

```bash
sudo pip install websockify
```

### 3. Install Nginx and Certbot
Install Nginx to serve as a reverse proxy and Certbot to obtain SSL certificates:

```bash
sudo yum install nginx certbot python3-certbot-nginx
```

### 4. Obtain SSL Certificates with Certbot
Use Certbot to generate SSL certificates for your domain:

```bash
sudo certbot --nginx -d yourdomain.com
```

Follow the interactive prompts to verify your domain and obtain the certificates. Certbot will automatically configure Nginx to use the certificates.

### 5. Create a Systemd Script
Set up a `systemd` service to proxy KST chat onto a local port (e.g., port 6000). This port is local only, so no need to open it in the firewall.

#### Example Systemd Script
Create a file named `/etc/systemd/system/kst2you.service` with the following content:

```ini
[Unit]
Description=KST Websockify Proxy Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/websockify 0.0.0.0:6000 www.on4kst.info:23001
Restart=on-failure
User=nobody
WorkingDirectory=/tmp
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=kst2you

[Install]
WantedBy=multi-user.target
```

### 6. Reload and Enable the Service
After creating the service file, reload the systemd daemon to recognize the new service:

```bash
sudo systemctl daemon-reload
```

Enable the service to start automatically on boot:

```bash
sudo systemctl enable kst2you
```

### 7. Start the Service
Start the proxy service:

```bash
sudo systemctl start kst2you
```

### 8. Verify the Service
Check the status of the service to ensure it is running:

```bash
sudo systemctl status kst2you
```

To confirm that the proxy is working, verify that the local port (6000) is listening:

```bash
ss -tuln | grep 6000
```

### 9. Configure Nginx for SSL Termination
Set up Nginx to reverse proxy requests to the Websockify service and expose it securely over HTTPS. The proxy will be accessible at `/kst/`.

#### Example Nginx Configuration
Add the following configuration to your Nginx site configuration (e.g., `/etc/nginx/conf.d/kst2you.conf`):

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # SSL settings (optional for better security)
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location /kst/ {
        proxy_pass http://127.0.0.1:6000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;

        # Optional WebSocket timeout settings
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}

server {
    listen 80;
    server_name yourdomain.com;

    # Redirect all HTTP traffic to HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}
```

### 10. Reload Nginx
After adding the configuration, reload Nginx to apply the changes:

```bash
sudo nginx -t  # Test the configuration for errors
sudo systemctl reload nginx
```

### 11. Automatically Renew SSL Certificates
Certbot can automatically renew SSL certificates. Add the following to your crontab to check for renewals regularly:

```bash
sudo crontab -e
```

Add this line to renew certificates and reload Nginx:

```bash
0 0 * * * certbot renew --quiet && systemctl reload nginx
```

You have now successfully set up a proxy server for KST2You. External clients can securely access the chat interface through your configured reverse proxy at `/kst/`. 

Let me know when your proxy is up and running, I will test it and add it to the list of proxies used in the software, improving the reliability for everyone, let me know if you need further assistance!


