# Install

```sh
sudo apt install php libapache2-mod-php apache2 mysql-server php-mysql curl git
a2enmod proxy
a2enmod headers
a2enmod rewrite
a2enmod proxy_http
mysql
    CREATE DATABASE hnschat;
    exit;
wget https://upload.woodburn.au/YvP/hnschat.sql
mysql -p hnschat < hnschat.sql
mysql
    CREATE USER 'hnschat'@'localhost' IDENTIFIED BY 'hnschat-password';
    GRANT ALL PRIVILEGES ON hnschat.* TO 'hnschat'@'localhost';
    FLUSH PRIVILEGES;
    exit;

```

## Setup Apache and web server
```sh
cd /var/www/html
git clone https://github.com/Nathanwoodburn/hnschat-web.git hnschat
cd hnschat/etc
cp config.sample.json config.json
#Edit config.json
cd ..
cp 000-default.conf /etc/apache2/sites-available
systemctl restart apache2
```

## Setup websocket server

```sh
cd /root
git clone https://github.com/Nathanwoodburn/hnschat-server.git
# Install node in case you don't have it
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22
npm install
cp config.sample.json config.json 
# Edit config.json
node server.js
```



## Websocket commands
Get identity from chrome dev tools either from the Websocket in network or from Application > Local Storage > session (Format should be Y2-...)


```json
IDENTIFY `IDENTITY HERE`
DOMAINS
DOMAIN `DOMAIN ID HERE`
CREATECHANNEL {"name":"`channel name`","user":"`domain id`","public":true,"tldadmin":false}
```


## Enable Channel

```sh
mysql
use hnschat;
UPDATE channels SET activated = 1, hidden = 0 WHERE name = "`channel name`"; 
```

## Enable SLDs on TLD
1. Create a channel for the TLD (needs to have the same name as the TLD)
2. Run this to enable SLDs
```sh
mysql
use hnschat;
UPDATE channels SET slds = 1 WHERE name = "`TLD`"; 
```