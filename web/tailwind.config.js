export default {
  content: ['./index.html', './admin.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { colors: { bg: '#0b0e13', panel: '#171c24', line: '#2a3340', ok: '#22c55e', warn: '#f59e0b', err: '#ef4444', acc: '#38bdf8' },
    keyframes: { indet: { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(250%)' } } },
    animation: { indet: 'indet 1.4s ease-in-out infinite' } } },
}
