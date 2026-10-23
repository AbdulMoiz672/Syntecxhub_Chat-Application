import { defineConfig } from 'vite';
export default defineConfig({base:process.env.VITE_BASE_PATH||'/',server:{proxy:{'/api':'http://localhost:3001','/socket.io':{target:'http://localhost:3001',ws:true}}}});
