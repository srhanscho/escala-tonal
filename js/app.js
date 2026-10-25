// Parte de la pagina: captura el audio con la Web Audio API, manda los cuadros
// al Web Worker y muestra los resultados que devuelve.

var NOMBRES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
var INTERVALO_MS = 60;

var ctx = null;          // AudioContext
var analizador = null;   // AnalyserNode
var buffer = null;       // muestras en el dominio del tiempo
var fuentes = [];        // nodos activos (microfono, osciladores o archivo)
var flujoMic = null;
var temporizador = null;
var ocupado = false;     // true mientras el worker procesa un cuadro
var audioArchivo = null; // AudioBuffer del archivo cargado
var escalaActual = null;
var sesion = 0;          // evita que el final de una reproduccion vieja detenga la nueva

var worker = new Worker('js/worker.js');
worker.onmessage = alRecibir;

function $(id) { return document.getElementById(id); }

function iniciarContexto() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  analizador = ctx.createAnalyser();
  analizador.fftSize = 4096;
  buffer = new Float32Array(analizador.fftSize);
}

// Cada INTERVALO_MS se toma una ventana de 4096 muestras y se envia al worker
function empezarCaptura(texto) {
  $('estado').textContent = texto;
  $('btnDetener').disabled = false;
  if (temporizador) return;
  temporizador = setInterval(function () {
    if (ocupado) return; // si el worker sigue ocupado se salta este cuadro
    analizador.getFloatTimeDomainData(buffer);
    var copia = new Float32Array(buffer);
    ocupado = true;
    worker.postMessage({ tipo: 'cuadro', datos: copia, sr: ctx.sampleRate }, [copia.buffer]);
  }, INTERVALO_MS);
}

function detener() {
  sesion++;
  clearInterval(temporizador);
  temporizador = null;
  fuentes.forEach(function (f) {
    try { if (f.stop) f.stop(); } catch (e) { /* ya estaba detenido */ }
    f.disconnect();
  });
  fuentes = [];
  if (flujoMic) {
    flujoMic.getTracks().forEach(function (t) { t.stop(); });
    flujoMic = null;
  }
  $('btnDetener').disabled = true;
  $('estado').textContent = 'Detenido';
}

function usarMicrofono() {
  iniciarContexto();
  detener();
  // se desactivan los filtros del navegador porque alteran el tono
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  }).then(function (flujo) {
    flujoMic = flujo;
    var fuente = ctx.createMediaStreamSource(flujo);
    fuente.connect(analizador); // no se conecta a los parlantes para evitar acople
    fuentes.push(fuente);
    empezarCaptura('Escuchando el microfono...');
  }).catch(function (err) {
    $('estado').textContent = 'No se pudo usar el microfono: ' + err.message;
  });
}

// Genera una melodia con osciladores: escala subiendo y bajando y un arpegio de la tonica
function reproducirPrueba() {
  iniciarContexto();
  ctx.resume();
  detener();
  var partes = $('selPrueba').value.split(',');
  var tonica = parseInt(partes[0], 10), modo = partes[1];
  var esc = modo === 'mayor' ? [0, 2, 4, 5, 7, 9, 11, 12] : [0, 2, 3, 5, 7, 8, 11, 12];
  var arp = modo === 'mayor' ? [0, 4, 7, 12, 7, 4] : [0, 3, 7, 12, 7, 3];

  var secuencia = [];
  esc.forEach(function (s) { secuencia.push([s, 0.3]); });
  esc.slice(0, -1).reverse().forEach(function (s) { secuencia.push([s, 0.3]); });
  arp.forEach(function (s) { secuencia.push([s, 0.45]); });
  secuencia.push([0, 0.9]);

  var volumen = ctx.createGain();
  volumen.gain.value = 0.25;
  volumen.connect(ctx.destination);

  var mia = ++sesion;
  var t = ctx.currentTime + 0.05;
  secuencia.forEach(function (p, i) {
    var osc = ctx.createOscillator();
    var env = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 440 * Math.pow(2, (tonica + p[0] - 69) / 12);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.01);
    env.gain.setValueAtTime(1, t + p[1] - 0.05);
    env.gain.linearRampToValueAtTime(0, t + p[1]);
    osc.connect(env);
    env.connect(analizador);
    env.connect(volumen);
    osc.start(t);
    osc.stop(t + p[1]);
    if (i === secuencia.length - 1) {
      osc.onended = function () { if (mia === sesion) setTimeout(detener, 200); };
    }
    fuentes.push(osc);
    t += p[1];
  });
  fuentes.push(volumen);
  empezarCaptura('Reproduciendo escala de prueba...');
}

// El archivo se decodifica y se manda completo al worker para analizarlo de una vez
function cargarArchivo(e) {
  var arch = e.target.files[0];
  if (!arch) return;
  iniciarContexto();
  detener();
  $('estado').textContent = 'Decodificando ' + arch.name + '...';
  arch.arrayBuffer().then(function (datos) {
    return ctx.decodeAudioData(datos);
  }).then(function (audio) {
    audioArchivo = audio;
    $('btnEscuchar').disabled = false;
    // mezcla de todos los canales a mono
    var mono = new Float32Array(audio.length);
    for (var c = 0; c < audio.numberOfChannels; c++) {
      var canal = audio.getChannelData(c);
      for (var i = 0; i < audio.length; i++) mono[i] += canal[i] / audio.numberOfChannels;
    }
    $('estado').textContent = 'Analizando en el worker... 0 %';
    worker.postMessage({ tipo: 'archivo', datos: mono, sr: audio.sampleRate }, [mono.buffer]);
  }).catch(function (err) {
    $('estado').textContent = 'No se pudo leer el archivo: ' + err.message;
  });
}

function escucharArchivo() {
  if (!audioArchivo) return;
  ctx.resume();
  detener();
  worker.postMessage({ tipo: 'reiniciar' });
  var fuente = ctx.createBufferSource();
  fuente.buffer = audioArchivo;
  fuente.connect(analizador);
  fuente.connect(ctx.destination);
  var mia = ++sesion;
  fuente.onended = function () { if (mia === sesion) setTimeout(detener, 200); };
  fuente.start();
  fuentes.push(fuente);
  empezarCaptura('Reproduciendo archivo...');
}

function reiniciar() {
  worker.postMessage({ tipo: 'reiniciar' });
  escalaActual = null;
  $('nota').textContent = '-';
  $('frecuencia').textContent = '- Hz';
  $('claridad').textContent = 'claridad: -';
  $('escala').textContent = '-';
  $('notasEscala').textContent = '-';
  $('aviso').textContent = '';
  ['1', '2', '3'].forEach(function (n) { $('c' + n).textContent = '-'; $('r' + n).textContent = '-'; });
  dibujarPerfil([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  dibujarEspectro(null);
}

// ---------- Resultados del worker ----------

function alRecibir(e) {
  var m = e.data;
  if (m.tipo === 'cuadro') {
    ocupado = false;
    mostrarNota(m);
    mostrarEscalas(m.escalas, m.perfil);
    dibujarEspectro(m.espectro);
    $('info').textContent = 'Worker: ultimo cuadro procesado en ' + m.ms + ' ms. Cuadros con tono: ' + m.conTono + '.';
  } else if (m.tipo === 'progreso') {
    $('estado').textContent = 'Analizando en el worker... ' + Math.round(m.valor * 100) + ' %';
  } else if (m.tipo === 'archivo-listo') {
    $('estado').textContent = 'Archivo analizado';
    mostrarEscalas(m.escalas, m.perfil);
    $('info').textContent = 'Worker: ' + m.duracion.toFixed(1) + ' s de audio, ' + m.cuadros +
      ' cuadros (' + m.conTono + ' con tono) analizados en ' + m.ms + ' ms.';
  }
}

function mostrarNota(m) {
  if (!m.nota) {
    $('claridad').textContent = m.rms < 0.01 ? 'silencio' : 'no hay un tono claro';
    return;
  }
  $('nota').textContent = m.nota.nombre;
  $('frecuencia').textContent = m.frecuencia.toFixed(1) + ' Hz  (' + (m.nota.cents >= 0 ? '+' : '') + m.nota.cents + ' cents)';
  $('claridad').textContent = 'claridad: ' + m.claridad.toFixed(2);
  $('aguja').style.left = (50 + m.nota.cents) + '%';
}

function mostrarEscalas(escalas, perfil) {
  dibujarPerfil(perfil);
  if (!escalas || escalas.length === 0) return;

  // cuantas notas distintas tienen un peso apreciable
  var distintas = perfil.filter(function (v) { return v > 0.04; }).length;
  var e = escalas[0];
  escalaActual = e;
  $('escala').textContent = e.nombre;
  $('notasEscala').textContent = e.notas.join(' - ');
  if (distintas < 4) {
    $('aviso').textContent = 'Todavia hay pocas notas distintas; toque o cante mas notas para confirmar la escala.';
  } else if (escalas[0].r - escalas[1].r < 0.03) {
    $('aviso').textContent = 'Resultado ambiguo entre ' + escalas[0].nombre + ' y ' + escalas[1].nombre + '.';
  } else {
    $('aviso').textContent = '';
  }
  for (var i = 0; i < 3; i++) {
    $('c' + (i + 1)).textContent = escalas[i].nombre;
    $('r' + (i + 1)).textContent = escalas[i].r.toFixed(3);
  }
}

// ---------- Dibujo ----------

function dibujarPerfil(perfil) {
  var cv = $('cvPerfil'), g = cv.getContext('2d');
  var W = cv.width, H = cv.height, ancho = W / 12;
  var max = Math.max.apply(null, perfil) || 1;
  g.clearRect(0, 0, W, H);
  for (var i = 0; i < 12; i++) {
    var alto = (perfil[i] / max) * (H - 30);
    var enEscala = escalaActual && escalaActual.clases.indexOf(i) >= 0;
    g.fillStyle = enEscala ? '#1a5276' : '#aab7c4';
    g.fillRect(i * ancho + 8, H - 20 - alto, ancho - 16, alto);
    g.fillStyle = '#333';
    g.font = '13px Arial';
    g.textAlign = 'center';
    g.fillText(NOMBRES[i], i * ancho + ancho / 2, H - 5);
  }
}

function dibujarEspectro(esp) {
  var cv = $('cvEspectro'), g = cv.getContext('2d');
  var W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#777';
  g.font = '11px Arial';
  for (var f = 0; f <= 2000; f += 250) {
    var x = f / 2000 * W;
    g.fillRect(x, H - 14, 1, 4);
    g.fillText(f + '', x + 2, H - 2);
  }
  if (!esp) return;
  // decibeles relativos al pico, para que se vean tambien los armonicos debiles
  var pico = 1e-9;
  for (var k = 0; k < esp.length; k++) if (esp[k] > pico) pico = esp[k];
  g.strokeStyle = '#c0392b';
  g.beginPath();
  for (var i = 0; i < esp.length; i++) {
    var db = 20 * Math.log((esp[i] + 1e-12) / pico) / Math.LN10;
    var y = 4 + (H - 20) * Math.min(1, -db / 70);
    var px = i / (esp.length - 1) * W;
    if (i === 0) g.moveTo(px, y); else g.lineTo(px, y);
  }
  g.stroke();
}

$('btnMic').onclick = usarMicrofono;
$('btnPrueba').onclick = reproducirPrueba;
$('btnDetener').onclick = detener;
$('btnReiniciar').onclick = reiniciar;
$('btnEscuchar').onclick = escucharArchivo;
$('archivo').onchange = cargarArchivo;
reiniciar();
