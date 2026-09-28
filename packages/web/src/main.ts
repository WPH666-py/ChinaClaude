import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

/**
 * The Tauri shell injects the effective bridge URL before the app boots, because the
 * bridge picks its own port at runtime (port 0) and the webview must not guess.
 */
createApp(App).mount('#app')
