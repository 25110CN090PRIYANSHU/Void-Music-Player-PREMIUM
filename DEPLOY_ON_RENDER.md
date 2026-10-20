# 🚀 Deploying VOID Music Player + Premium on Render

This guide walks you through deploying your unified **VOID Music Player** (Classic + Premium) to [Render.com](https://render.com) completely for free.

---

## 📋 Pre-Flight Checklist (1 Minute)

### 1. MongoDB Atlas Network Access (Crucial!)
Because cloud servers use dynamic IPs, you must allow connections from any IP:
1. Open [MongoDB Atlas](https://cloud.mongodb.com/).
2. In the left sidebar, click **Network Access** (under Security).
3. If `0.0.0.0/0` is not listed, click **+ Add IP Address**.
4. Click **Allow Access from Anywhere** (`0.0.0.0/0`) and click **Confirm**.

---

## 🛠️ Step-by-Step Deployment Instructions

### Step 1: Push this Folder to GitHub

Open a terminal (PowerShell or Command Prompt) inside this folder:
```powershell
cd "C:\Users\xproo\Desktop\VOID MUSIC PLAYER +PREMIUM"
git init
git add .
git commit -m "Initial commit for VOID Music Player"
git branch -M main
```

Now create a new **private** or **public** repository on [GitHub](https://github.com/new) named `void-music-player`, and push your code:
```powershell
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/void-music-player.git
git push -u origin main
```
*(Alternatively, you can drag and drop these files directly into the GitHub repository website).*

---

### Step 2: Create a Web Service on Render

1. Log in to your [Render Dashboard](https://dashboard.render.com/).
2. Click the blue **"New +"** button at the top-right and select **"Web Service"**.
3. Choose **"Build and deploy from a Git repository"** and click **Next**.
4. Connect your GitHub account and select your `void-music-player` repository.

---

### Step 3: Configure Web Service Settings

Fill in the settings on the Render configuration page:

| Setting | Value |
| :--- | :--- |
| **Name** | `void-music-player` *(or your preferred name)* |
| **Region** | `Singapore` or `Frankfurt` *(choose closest to your listeners)* |
| **Branch** | `main` |
| **Root Directory** | *(Leave blank)* |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Instance Type** | `Free` |

---

### Step 4: Add Environment Variables

Scroll down to the **Environment Variables** section and add the following keys:

| Key | Value | Description |
| :--- | :--- | :--- |
| `MONGO_URI` | `mongodb+srv://gamingxprohindi_db_user:J5QDgZeRmMri0wC8@attendease.9f4ymna.mongodb.net/?appName=AttendEase` | Your MongoDB connection string |
| `JWT_SECRET` | `void_player_super_secret_jwt_key_2026` | Token encryption secret |
| `NODE_ENV` | `production` | Production mode |

*(Note: You do not need to add `PORT`. Render sets and assigns `PORT` automatically).*

---

### Step 5: Deploy!

Click the **"Create Web Service"** button at the bottom.

Render will now:
1. Clone your repository.
2. Run `npm install` to install backend dependencies.
3. Start `node server.js`.
4. Connect to your MongoDB database.

Within **2–3 minutes**, you will see:
```text
==> Your service is live 🎉
MongoDB connected successfully to database: voidplayer
=======================================================
       VOID MUSIC PLAYER — UNIFIED MERGED EDITION
=======================================================
Server running on:     http://localhost:10000
Classic VOID Player:   http://localhost:10000/
Premium VOID Player:   http://localhost:10000/premium
=======================================================
```

---

## 🌐 Your Live URLs
At the top of your Render dashboard, you will find your permanent public URL (e.g. `https://void-music-player.onrender.com`):
* **Classic Player**: `https://your-subdomain.onrender.com/`
* **Premium Indian Player**: `https://your-subdomain.onrender.com/premium`
* **PWA Install**: Visit on phone or desktop and click **"Install App"**!

---

## ⚡ Keep Render Awake 24/7 (Prevent Free Tier Inactivity Sleep)
Render's free tier spins down after 15 minutes of inactivity. When someone visits, it can take 30–50 seconds to wake up.

To keep it awake **24/7 with zero lag**:
1. Go to [UptimeRobot.com](https://uptimerobot.com/) and create a free account.
2. Click **+ Add New Monitor**.
3. Choose Monitor Type: **HTTP(s)**.
4. Friendly Name: `VOID Player Keep-Alive`.
5. URL: `https://your-subdomain.onrender.com/api/health`.
6. Monitoring Interval: **Every 10 minutes**.
7. Click **Create Monitor**.

Now UptimeRobot will ping your server every 10 minutes, keeping your music player warm, instant, and online 24/7!
