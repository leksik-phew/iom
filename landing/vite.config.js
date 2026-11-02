import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
// Relative asset paths let the build work under any GitHub Pages path (user.github.io/repo/).
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),base:'./',build:{outDir:'dist',emptyOutDir:true},server:{port:5180}});
