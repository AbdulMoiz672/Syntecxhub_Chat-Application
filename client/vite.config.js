import { defineConfig } from 'vite';
export default defineConfig({server:{proxy:{'/api':'http://localhost:3001','/socket.io':{target:'http://localhost:3001',ws:true}}}});
