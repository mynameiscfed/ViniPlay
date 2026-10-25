/**
 * Tailwind build for ViniPlay.
 *
 * The compiled stylesheet is committed (public/css/tailwind.css) so the server and the
 * Docker image need no build step. After changing classes in index.html or public/js,
 * run `npm run build:css` and commit the result.
 *
 * Colours come from CSS variables (public/css/tokens.css) so the whole app, including
 * markup that is generated from JavaScript, follows the light/dark theme.
 */
const tok = (name) => `rgb(var(--${name}) / <alpha-value>)`;

const scale = (prefix, steps) =>
    Object.fromEntries(steps.map((s) => [s, tok(`${prefix}-${s}`)]));

const blue = scale('b', [200, 300, 400, 500, 600, 700, 800, 900]);
const red = scale('r', [200, 300, 400, 500, 600, 700, 800, 900, 950]);
const green = scale('gr', [200, 400, 500, 600, 700, 800, 900]);
const yellow = scale('y', [300, 400, 500, 600, 700, 800, 950]);
const purple = scale('p', [200, 400, 600, 700, 800]);

module.exports = {
    content: ['./public/index.html', './public/js/**/*.js'],
    theme: {
        colors: {
            transparent: 'transparent',
            current: 'currentColor',
            inherit: 'inherit',
            black: '#000',
            white: tok('g-white'),
            gray: scale('g', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
            blue,
            indigo: blue,
            sky: blue,
            cyan: blue,
            red,
            rose: red,
            green,
            emerald: green,
            yellow,
            amber: yellow,
            orange: yellow,
            purple,
            pink: purple,
        },
        extend: {
            fontFamily: {
                sans: ['Figtree', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
                display: ['Bricolage Grotesque', 'Figtree', 'system-ui', 'sans-serif'],
                mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
            },
            borderRadius: {
                md: '10px',
                lg: '12px',
                xl: '16px',
                '2xl': '20px',
            },
        },
    },
    plugins: [],
};
