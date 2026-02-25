/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                background: '#f3f3f3',
                surface: '#FFFFFF',
                muted: '#EAEAEA',
                'accent-green': '#0A7739',
                border: '#131313',
                text: '#131313',
                white: '#f3f3f3',
                black: '#131313'
            },
            fontFamily: {
                serif: ['"Instrument Serif"', 'serif'],
                sans: ['Inter', 'system-ui', 'sans-serif'],
            },
            letterSpacing: {
                'tightest': '-0.05em',
            },
            borderWidth: {
                '3': '3px',
            }
        },
    },
    plugins: [],
}
