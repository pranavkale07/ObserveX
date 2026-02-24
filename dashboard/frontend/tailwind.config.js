/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                'dashboard-dark': '#020617',
                'anomaly-red': '#f43f5e',
                'anomaly-orange': '#fb923c',
                'safe-green': '#10b981',
            },
            animation: {
                'spin-slow': 'spin 3s linear infinite',
            },
        },
    },
    plugins: [],
}
