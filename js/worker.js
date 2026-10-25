// Web Worker que hace todo el analisis pesado del audio:
// FFT, autocorrelacion (deteccion de tono), cromagrama y estimacion de la escala.
// No usa librerias, todo esta implementado aqui con Math.

var NOMBRES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
var NOMBRES_B = ['Do', 'Re♭', 'Re', 'Mi♭', 'Mi', 'Fa', 'Sol♭', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];

// Perfiles de Krumhansl-Kessler: que tan "estable" se percibe cada grado en la escala
var PERFIL_MAYOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
var PERFIL_MENOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Intervalos en semitonos desde la tonica
var PASOS_MAYOR = [0, 2, 4, 5, 7, 9, 11];
var PASOS_MENOR = [0, 2, 3, 5, 7, 8, 10];

// Tonalidades que se escriben con bemoles
var BEMOLES_MAYOR = [5, 10, 3, 8, 1];
var BEMOLES_MENOR = [2, 7, 0, 5, 10];

var UMBRAL_SILENCIO = 0.01; // RMS minimo para considerar que hay sonido
var UMBRAL_CLARIDAD = 0.6;  // pico minimo de la NSDF para aceptar un tono
var F_MIN = 60, F_MAX = 1500;

// ---------- FFT radix-2 (Cooley-Tukey iterativa) ----------

function siguientePotencia2(n) {
  var p = 1;
  while (p < n) p *= 2;
  return p;
}

// Transforma re/im en el mismo arreglo. La longitud debe ser potencia de 2.
function fft(re, im) {
  var n = re.length, i, j, k, t;

  // reordenamiento por inversion de bits
  for (i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  // mariposas
  for (var len = 2; len <= n; len <<= 1) {
    var mitad = len >> 1;
    var ang = -2 * Math.PI / len;
    for (k = 0; k < mitad; k++) {
      var wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      for (i = k; i < n; i += len) {
        j = i + mitad;
        var tr = re[j] * wr - im[j] * wi;
        var ti = re[j] * wi + im[j] * wr;
        re[j] = re[i] - tr; im[j] = im[i] - ti;
        re[i] += tr; im[i] += ti;
      }
    }
  }
}

// Espectro de magnitud con ventana de Hann
function espectro(x) {
  var n = x.length, N = siguientePotencia2(n);
  var re = new Float64Array(N), im = new Float64Array(N);
  for (var i = 0; i < n; i++) {
    var w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    re[i] = x[i] * w;
  }
  fft(re, im);
  var mag = new Float64Array(N / 2);
  for (var k = 0; k < N / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  return { mag: mag, N: N };
}

// ---------- Autocorrelacion ----------

// r(tau) usando el teorema de Wiener-Khinchin: r = IFFT(|FFT(x)|^2)
// Se rellena con ceros hasta 2n para que la correlacion no sea circular.
function autocorrelacion(x) {
  var n = x.length, N = siguientePotencia2(2 * n);
  var re = new Float64Array(N), im = new Float64Array(N);
  for (var i = 0; i < n; i++) re[i] = x[i];
  fft(re, im);
  for (var k = 0; k < N; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k];
    im[k] = 0;
  }
  // la potencia es real y simetrica, asi que la FFT directa / N sirve como inversa
  fft(re, im);
  var r = new Float64Array(n);
  for (var t = 0; t < n; t++) r[t] = re[t] / N;
  return r;
}

// Funcion de diferencia cuadrada normalizada (NSDF, McLeod y Wyvill)
// nsdf(tau) = 2 r(tau) / m(tau), con valores entre -1 y 1
function nsdf(x, tauMax) {
  var n = x.length;
  var r = autocorrelacion(x);
  var m = 0, i;
  for (i = 0; i < n; i++) m += 2 * x[i] * x[i];
  var out = new Float64Array(tauMax + 2);
  for (var tau = 0; tau < out.length; tau++) {
    out[tau] = m > 0 ? 2 * r[tau] / m : 0;
    m -= x[tau] * x[tau] + x[n - 1 - tau] * x[n - 1 - tau];
  }
  return out;
}

function rms(x) {
  var s = 0;
  for (var i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

// Devuelve {frecuencia, claridad} o null si no hay un tono claro
function detectarTono(x, sr) {
  if (rms(x) < UMBRAL_SILENCIO) return null;
  var tauMin = Math.floor(sr / F_MAX);
  var tauMax = Math.min(Math.floor(x.length / 2), Math.ceil(sr / F_MIN));
  var d = nsdf(x, tauMax);

  // buscar el maximo de cada zona positiva despues del primer cruce por cero
  var picos = [], tau = 1;
  while (tau < tauMax && d[tau] > 0) tau++;
  var mejor = -1, mejorTau = -1;
  for (; tau <= tauMax; tau++) {
    if (d[tau] > 0) {
      if (d[tau] > mejor) { mejor = d[tau]; mejorTau = tau; }
    } else if (mejorTau > 0) {
      picos.push(mejorTau);
      mejor = -1; mejorTau = -1;
    }
  }
  if (mejorTau > 0) picos.push(mejorTau);
  picos = picos.filter(function (p) { return p >= tauMin && p < tauMax; });
  if (picos.length === 0) return null;

  var maximo = 0;
  picos.forEach(function (p) { if (d[p] > maximo) maximo = d[p]; });

  // primer pico que llegue al 90 % del maximo (evita elegir la octava de abajo)
  var elegido = picos[0];
  for (var i = 0; i < picos.length; i++) {
    if (d[picos[i]] >= 0.9 * maximo) { elegido = picos[i]; break; }
  }

  // interpolacion parabolica para afinar el periodo
  var a = d[elegido - 1], b = d[elegido], c = d[elegido + 1];
  var den = a - 2 * b + c;
  var delta = den !== 0 ? 0.5 * (a - c) / den : 0;
  var claridad = b - 0.25 * (a - c) * delta;
  if (claridad < UMBRAL_CLARIDAD) return null;

  return { frecuencia: sr / (elegido + delta), claridad: claridad };
}

// ---------- Notas y escalas ----------

function midiDesdeFrecuencia(f) {
  return 12 * Math.log(f / 440) / Math.LN2 + 69;
}

function nota(f) {
  var m = midiDesdeFrecuencia(f);
  var n = Math.round(m);
  return {
    midi: n,
    clase: ((n % 12) + 12) % 12,
    nombre: NOMBRES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1),
    cents: Math.round((m - n) * 100)
  };
}

// Cromagrama: suma la energia del espectro en cada una de las 12 clases de nota
function croma(mag, N, sr) {
  var c = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  var kMin = Math.ceil(110 * N / sr), kMax = Math.floor(2000 * N / sr);
  for (var k = kMin; k <= kMax; k++) {
    var pc = ((Math.round(midiDesdeFrecuencia(k * sr / N)) % 12) + 12) % 12;
    c[pc] += mag[k] * mag[k];
  }
  return c;
}

function normalizar(v) {
  var s = 0, i;
  for (i = 0; i < v.length; i++) s += v[i];
  var out = new Array(v.length);
  for (i = 0; i < v.length; i++) out[i] = s > 0 ? v[i] / s : 0;
  return out;
}

// Correlacion de Pearson entre dos vectores de 12 valores
function pearson(x, y) {
  var mx = 0, my = 0, i;
  for (i = 0; i < 12; i++) { mx += x[i]; my += y[i]; }
  mx /= 12; my /= 12;
  var num = 0, dx = 0, dy = 0;
  for (i = 0; i < 12; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) * (x[i] - mx);
    dy += (y[i] - my) * (y[i] - my);
  }
  return (dx === 0 || dy === 0) ? 0 : num / Math.sqrt(dx * dy);
}

function nombreEscala(tonica, modo) {
  var bemol = (modo === 'mayor' ? BEMOLES_MAYOR : BEMOLES_MENOR).indexOf(tonica) >= 0;
  var nombres = bemol ? NOMBRES_B : NOMBRES;
  var pasos = modo === 'mayor' ? PASOS_MAYOR : PASOS_MENOR;
  return {
    nombre: nombres[tonica] + ' ' + modo,
    tonica: tonica,
    modo: modo,
    notas: pasos.map(function (p) { return nombres[(tonica + p) % 12]; }),
    clases: pasos.map(function (p) { return (tonica + p) % 12; })
  };
}

// Algoritmo de Krumhansl-Schmuckler: compara el perfil con las 24 tonalidades
function estimarEscala(perfil) {
  var total = 0;
  for (var i = 0; i < 12; i++) total += perfil[i];
  if (total === 0) return [];
  var res = [];
  for (var t = 0; t < 12; t++) {
    var rotM = [], rotm = [];
    for (var k = 0; k < 12; k++) {
      rotM.push(PERFIL_MAYOR[(k - t + 12) % 12]);
      rotm.push(PERFIL_MENOR[(k - t + 12) % 12]);
    }
    var eM = nombreEscala(t, 'mayor'); eM.r = pearson(perfil, rotM); res.push(eM);
    var em = nombreEscala(t, 'menor'); em.r = pearson(perfil, rotm); res.push(em);
  }
  res.sort(function (a, b) { return b.r - a.r; });
  return res.slice(0, 3);
}

// ---------- Estado acumulado ----------

function nuevoEstado() {
  return {
    histograma: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // notas detectadas por autocorrelacion
    croma: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],      // energia por clase desde la FFT
    cuadros: 0,
    conTono: 0
  };
}

// El perfil final combina el histograma de notas y el cromagrama, cada uno normalizado
function perfilCombinado(est) {
  var h = normalizar(est.histograma), c = normalizar(est.croma);
  var p = [];
  for (var i = 0; i < 12; i++) p.push((h[i] + c[i]) / 2);
  return p;
}

function analizarCuadro(x, sr, est) {
  var res = { rms: rms(x), tono: null, nota: null };
  est.cuadros++;
  if (res.rms < UMBRAL_SILENCIO) return res;

  var esp = espectro(x);
  var cr = normalizar(croma(esp.mag, esp.N, sr));
  for (var i = 0; i < 12; i++) est.croma[i] += cr[i];
  res.espectro = esp;

  var t = detectarTono(x, sr);
  if (t) {
    res.tono = t;
    res.nota = nota(t.frecuencia);
    est.histograma[res.nota.clase] += t.claridad;
    est.conTono++;
  }
  return res;
}

// Reduce el espectro a pocos puntos (0 a 2000 Hz) para dibujarlo en la pagina
function espectroParaDibujo(esp, sr, puntos) {
  var out = new Float32Array(puntos);
  var kMax = Math.floor(2000 * esp.N / sr);
  for (var i = 0; i < puntos; i++) {
    var k0 = Math.floor(i * kMax / puntos), k1 = Math.floor((i + 1) * kMax / puntos);
    var m = 0;
    for (var k = k0; k <= k1; k++) if (esp.mag[k] > m) m = esp.mag[k];
    out[i] = m;
  }
  return out;
}

// Analiza un archivo completo por cuadros de 4096 muestras con salto de 2048
function analizarSenal(datos, sr, alAvanzar) {
  var est = nuevoEstado(), TAM = 4096, SALTO = 2048;
  var total = Math.max(1, Math.floor((datos.length - TAM) / SALTO) + 1);
  var notas = [];
  for (var c = 0; c < total; c++) {
    var cuadro = datos.subarray(c * SALTO, c * SALTO + TAM);
    if (cuadro.length < TAM) break;
    var r = analizarCuadro(cuadro, sr, est);
    if (r.nota) notas.push(r.nota.clase);
    if (alAvanzar && c % 40 === 0) alAvanzar(c / total);
  }
  return { estado: est, notas: notas, cuadros: total };
}

// ---------- Comunicacion con la pagina ----------

var estado = nuevoEstado();

function alRecibir(e) {
  var msg = e.data, inicio = Date.now();

  if (msg.tipo === 'reiniciar') {
    estado = nuevoEstado();
    return;
  }

  if (msg.tipo === 'cuadro') {
    var r = analizarCuadro(msg.datos, msg.sr, estado);
    self.postMessage({
      tipo: 'cuadro',
      rms: r.rms,
      frecuencia: r.tono ? r.tono.frecuencia : 0,
      claridad: r.tono ? r.tono.claridad : 0,
      nota: r.nota,
      espectro: r.espectro ? espectroParaDibujo(r.espectro, msg.sr, 256) : null,
      perfil: perfilCombinado(estado),
      escalas: estimarEscala(perfilCombinado(estado)),
      conTono: estado.conTono,
      ms: Date.now() - inicio
    });
    return;
  }

  if (msg.tipo === 'archivo') {
    var a = analizarSenal(msg.datos, msg.sr, function (p) {
      self.postMessage({ tipo: 'progreso', valor: p });
    });
    estado = a.estado;
    var perfil = perfilCombinado(a.estado);
    self.postMessage({
      tipo: 'archivo-listo',
      perfil: perfil,
      escalas: estimarEscala(perfil),
      cuadros: a.cuadros,
      conTono: a.estado.conTono,
      duracion: msg.datos.length / msg.sr,
      ms: Date.now() - inicio
    });
  }
}

if (typeof module !== 'undefined') {
  // para poder probar las funciones con Node
  module.exports = {
    fft: fft, autocorrelacion: autocorrelacion, detectarTono: detectarTono, nota: nota,
    estimarEscala: estimarEscala, analizarSenal: analizarSenal, perfilCombinado: perfilCombinado
  };
} else {
  self.onmessage = alRecibir;
}
