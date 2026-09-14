import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],server:{host:'127.0.0.1',port:5176,strictPort:true,proxy:{'/api':'http://127.0.0.1:8789'}},build:{rollupOptions:{output:{manualChunks:(id)=>id.includes('/node_modules/three/')?'three':id.includes('/node_modules/react')?'react':undefined}}}});
