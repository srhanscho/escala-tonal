# Reconocimiento de escala tonal

Demo para la actividad de procesamiento de audio. Detecta la nota que suena y estima la escala (tonalidad) de un sonido usando la Web Audio API, un Web Worker, la transformada rápida de Fourier y la autocorrelación.

No usa librerías externas: la FFT, la autocorrelación y la estimación de la escala están implementadas en `js/worker.js`.

## Estructura

- `index.html`: interfaz
- `estilos.css`: estilos
- `js/app.js`: captura del audio con la Web Audio API (micrófono, escala de prueba o archivo) y dibujo de resultados
- `js/worker.js`: Web Worker con el análisis (FFT, autocorrelación NSDF, cromagrama y algoritmo de Krumhansl-Schmuckler)

## Uso

El Web Worker no carga si se abre `index.html` con doble clic (`file://`), así que hay que servir la carpeta, por ejemplo con la extensión Live Server de VS Code o con:

```
python -m http.server 5510
```

y abrir http://localhost:5510.

Autor: Han's De Ávila Sánchez, Universidad de la Costa.
