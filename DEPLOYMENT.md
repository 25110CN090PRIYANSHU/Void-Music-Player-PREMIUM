# 🚀 VOID Music Player — Production Deployment Guide

This guide walks you through deploying **VOID Music Player** (Unified Edition with Classic VOID & Free VOID Premium Indian Music Player) to free cloud hosting platforms.

---

## ⚡ Quick Deployment Summary

| Platform | Free Tier | Setup Time | Recommended For |
|---|---|---|---|
| **[Render](https://render.com)** | ✅ Yes | 2 mins | **Best overall (Recommended)** |
| **[Railway](https://railway.app)** | ✅ Yes ($5 trial credit) | 1 min | Fastest 1-click deploy |
| **[Koyeb](https://www.koyeb.com)** | ✅ Yes | 3 mins | Modern fast container deploy |
| **[Docker / VPS](https://docker.com)** | Self-hosted | 2 mins | DigitalOcean, AWS, Linode |

---

## 🗄️ Step 1: Set Up Free Cloud MongoDB Atlas (3 Minutes)

Both the Classic Player and Premium Player share user accounts, playlists, favorites, and profile pictures using MongoDB.

1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) and create a free account.
2. Click **Create a Deployment** and select the **M0 FREE** shared cluster.
3. Choose a cloud provider and region closest to your users (e.g., AWS Mumbai `ap-south-1`).
4. Set up security:
   - **Database User**: Create a username (e.g. `voidadmin`) and password (save the password!).
   - **IP Access List**: Add `0.0.0.0/0` (Allow Access from Anywhere) so cloud servers can connect.
5. Click **Connect** → **Drivers** (Node.js).
6. Copy your connection string:
   ```text
   mongodb+srv://<username>:<password>@cluster0.abcde.mongodb.net/voidplayer?retryWrites=true&w=majority
   ```
   *(Replace `<username>` and `<password>` with the credentials you created).*

> **Note**: Even if MongoDB is not provided, VOID Player automatically runs in offline local store fallback mode with zero downtime!

---

## 🌐 Step 2: Deploy to Render (Recommended - Free)

1. **Push your code to GitHub**:
   ```bash
   git init
   git add .
   git commit -m "Deploy VOID Unified Music Player"
   # Create a repository on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/void-music-player.git
   git branch -M main
   git push -u origin main
   ```

2. **Create Web Service on Render**:
   - Go to [dashboard.render.com](https://dashboard.render.com) and click **New +** → **Web Service**.
   - Select your GitHub repository.
   - Configure settings:
     - **Name**: `void-music-player`
     - **Region**: Singapore or closest to you
     - **Branch**: `main`
     - **Runtime**: `Node`
     - **Build Command**: `npm install`
     - **Start Command**: `node server.js`
     - **Instance Type**: `Free`

3. **Add Environment Variables**:
   Click **Environment Variables** and add:
   | Key | Value | Description |
   |---|---|---|
   | `NODE_ENV` | `production` | Production mode |
   | `MONGO_URI` | `mongodb+srv://...` | Your MongoDB Atlas connection string |
   | `JWT_SECRET` | *(Any random string, e.g. `void_secret_key_prod_2026`)* | Token secret key |

4. Click **Create Web Service**.
   Render will build and deploy the app. In ~1 minute, you will receive a live URL:
   `https://void-music-player.onrender.com`

---

## 🚂 Step 3: Deploy to Railway (Alternative 1-Click)

1. Push your repository to GitHub.
2. Go to [railway.app](https://railway.app) and click **New Project** → **Deploy from GitHub repo**.
3. Select your repository.
4. Go to **Variables** tab and add:
   - `MONGO_URI`: `mongodb+srv://...`
   - `JWT_SECRET`: `void_secret_key_prod_2026`
5. Go to **Settings** → **Networking** → **Generate Domain**.
6. Railway automatically boots `node server.js` using the included `railway.json`.

---

## 🐳 Step 4: Deploy with Docker (Self-Hosted / VPS)

The project includes a multi-stage production [Dockerfile](file:///c:/Users/xproo/Desktop/VOID%20Music%20Player%20MAIN/Dockerfile).

```bash
# 1. Build Docker image
docker build -t void-music-player .

# 2. Run container
docker run -d \
  -p 3000:3000 \
  -e MONGO_URI="mongodb+srv://<user>:<pass>@cluster0.abcde.mongodb.net/voidplayer" \
  -e JWT_SECRET="your_production_secret_key" \
  --name void-player \
  void-music-player
```

---

## ✅ Post-Deployment Verification

Once deployed, visit your live URL:
- **`https://your-app-domain.com/login.html`**: Log in or create an account.
- **`https://your-app-domain.com/`**: Access Classic VOID YouTube player.
- **`https://your-app-domain.com/premium`**: Access Free VOID Premium Indian Music Player.
- **`https://your-app-domain.com/api/health`**: Verify backend and database health.
