
{
  "name": "gas-emergency-android",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "api:dev": "node server.js",
    "build": "vite build",
    "preview": "vite preview",
    "db:migrate": "node scripts/migrate.mjs",
    "android:add": "cap add android",
    "android:sync": "npm run build && cap sync android",
    "android:open": "cap open android"
  },
  "dependencies": {
    "@capacitor/android": "^8.0.0",
    "@capacitor/app": "^8.0.0",
    "@capacitor/core": "^8.0.0",
    "leaflet": "^1.9.4",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "recharts": "^2.13.3",
    "xlsx": "^0.18.5",
    "@libsql/client": "^0.15.15"
  },
  "devDependencies": {
    "@capacitor/cli": "^8.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^5.4.11"
  }
}
