// lizto-sync.js
require('dotenv').config();

const puppeteer = require('puppeteer');
const { MongoClient } = require('mongodb');

// ===================== ENV =====================
const {
  MONGO_URI,
  DB_NAME,
  APPOINTMENTS_COL,
  LIZTO_EMAIL,
  LIZTO_PASSWORD,
} = process.env;

if (!MONGO_URI || !DB_NAME || !APPOINTMENTS_COL || !LIZTO_EMAIL || !LIZTO_PASSWORD) {
  console.error('❌ Faltan variables de entorno en .env (MONGO_URI, DB_NAME, APPOINTMENTS_COL, LIZTO_EMAIL, LIZTO_PASSWORD)');
  process.exit(1);
}

// Defaults por si quieres usarlos
const DEFAULT_SEDE = process.env.DEFAULT_SEDE || 'Marquetalia';
const DEFAULT_USUARIO = process.env.DEFAULT_USUARIO || 'Leslie gutierrez';

// ===================== HELPERS =====================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Formatea la fecha en el estilo de tus CSV
function formatFechaBonita(dateObj) {
  const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const meses = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];

  const dName = dias[dateObj.getDay()];
  const day = dateObj.getDate();
  const monthName = meses[dateObj.getMonth()];
  const year = dateObj.getFullYear();

  return `${dName} ${day} de ${monthName} del ${year}`;
}

// Parsear fecha tipo: "miércoles, 19 de noviembre/2025"
function parseFechaDesdeTooltip(lineaFecha) {
  if (!lineaFecha) return null;

  const meses = {
    'enero': 0,
    'febrero': 1,
    'marzo': 2,
    'abril': 3,
    'mayo': 4,
    'junio': 5,
    'julio': 6,
    'agosto': 7,
    'septiembre': 8,
    'setiembre': 8,
    'octubre': 9,
    'noviembre': 10,
    'diciembre': 11,
  };

  // ejemplo: "miércoles, 19 de noviembre/2025"
  const re = /(\d{1,2})\s+de\s+([a-záéíóúñ]+)\/(\d{4})/i;
  const m = lineaFecha.match(re);
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const mesNombre = m[2].toLowerCase();
  const year = parseInt(m[3], 10);

  const month = meses[mesNombre];
  if (month === undefined) return null;

  return { day, month, year };
}

// Convierte "8:45 am" en hora/minuto y luego en Date usando la fecha
function buildAppointmentDate(fechaPart, horaStr) {
  if (!fechaPart || !horaStr) return null;

  const { day, month, year } = fechaPart;

  const mTime = horaStr.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!mTime) return null;

  let hour = parseInt(mTime[1], 10);
  const minute = parseInt(mTime[2], 10);
  const ampm = mTime[3].toLowerCase();

  if (ampm === 'pm' && hour < 12) {
    hour += 12;
  } else if (ampm === 'am' && hour === 12) {
    hour = 0;
  }

  return new Date(year, month, day, hour, minute);
}

// Mapea el texto de estado del tooltip
function mapEstadoFromText(textoEstadoRaw) {
  if (!textoEstadoRaw) return 'Nueva reserva creada';

  const t = textoEstadoRaw.toLowerCase();

  if (t.includes('pagada')) return 'Cita pagada';
  if (t.includes('cancelada')) return 'Cita cancelada';
  if (t.includes('reserva')) return 'Nueva reserva creada';

  return 'Nueva reserva creada';
}

// ===================== LOGIN LIZTO =====================
async function loginLizto(page) {
  console.log('🌐 Abriendo página de login de Lizto...');
  await page.goto('https://app.lizto.co/login', {
    waitUntil: 'networkidle2',
  });

  // Rellenar usuario y password
  await page.waitForSelector('#email', { timeout: 15000 });
  await page.type('#email', LIZTO_EMAIL, { delay: 30 });

  // El id de password puede variar, pero en tu ejemplo es "__BVID__6"
  // Usamos un selector más flexible
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await page.type('input[type="password"]', LIZTO_PASSWORD, { delay: 30 });

  // Botón login
  await page.click('#button-manual-submit');
  console.log('🔐 Iniciando sesión...');

  // Esperar a que cargue la pantalla principal
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  console.log('✅ Sesión iniciada en Lizto');

  // Ir al calendario
  console.log('📅 Abriendo calendario...');
  await page.goto('https://app.lizto.co/calendar', { waitUntil: 'networkidle2' });
  await sleep(3000);
}

// ===================== SCRAP DE UNA VISTA (SEMANA VISIBLE) =====================
async function syncVisibleWeek(page, appointmentsCol) {
  console.log('\n🌐 Sincronizando agenda desde Lizto (vista actual)...');

  // Esperamos a que el calendario esté visible
  await page.waitForSelector('.v-calendar-daily__body', { timeout: 15000 });

  // Todas las citas visibles (todas las columnas)
  const eventEls = await page.$$('.v-calendar-daily__body .v-event-timed.primary.white--text');
  console.log(`📋 Citas encontradas en pantalla: ${eventEls.length}`);

  let processed = 0;

  for (const ev of eventEls) {
    try {
      // 1) Datos básicos desde el cuadrito (card)
      const baseData = await page.evaluate((el) => {
        const card = el.querySelector('.v-event-draggable');
        if (!card) return null;

        const style = getComputedStyle(card);
        const bgColor = style.backgroundColor || '';

        const ps = card.querySelectorAll('p');

        const nombreLinea = ps[0]?.innerText || '';
        const cliente = nombreLinea.replace(/\s+/g, ' ').trim();

        const servicio = ps[1]?.innerText.replace(/\s+/g, ' ').trim() || '';

        const especialistaLinea = ps[2]?.innerText || '';
        let especialista = especialistaLinea.replace(/con/i, '').trim();
        especialista = especialista.replace(/\s+/g, ' ');

        const horaLinea = ps[3]?.innerText || '';
        // Ejemplo: "8:45 am - 9:00 am"
        const [horaInicioRaw, horaFinRaw] = horaLinea.split('-').map((s) => s.trim());

        return {
          cliente,
          servicio,
          especialista,
          horaInicioRaw,
          horaFinRaw,
          bgColor,
        };
      }, ev);

      if (!baseData || !baseData.cliente) {
        continue;
      }

      // 2) Hover para sacar el tooltip (teléfono, fecha exacta, etc.)
      await ev.hover();
      await sleep(250); // pequeño delay para que aparezca el tooltip

      const tooltip = await page.$('div.v-menu__content.menuable__content__active');
      let celular = null;
      let lineaFecha = null;
      let lineaHorasTooltip = null;
      let textoEstadoTooltip = null;

      if (tooltip) {
        const tooltipInfo = await page.evaluate((el) => {
          const info = {
            textoCompleto: el.innerText || '',
            lineas: [],
          };

          const ps = el.querySelectorAll('p');
          info.lineas = Array.from(ps).map((p) => p.innerText.trim());

          return info;
        }, tooltip);

        const textoTooltip = tooltipInfo.textoCompleto;
        const lineas = tooltipInfo.lineas || [];

        // Buscar celular tipo 3xxxxxxxxx
        const matchPhone = textoTooltip.match(/\b3\d{9}\b/);
        if (matchPhone) {
          celular = matchPhone[0];
        }

        // Buscar la línea de fecha (tiene año y "/" según tu ejemplo "miércoles, 19 de noviembre/2025")
        lineaFecha =
          lineas.find((l) => /\d{4}/.test(l) && l.includes('/')) || null;

        // Buscar la línea de horas "8:45 am - 9:00 am" (por si la del card falla)
        lineaHorasTooltip =
          lineas.find(
            (l) =>
              l.includes('-') &&
              (l.toLowerCase().includes('am') || l.toLowerCase().includes('pm')),
          ) || null;

        // Buscar la línea de estado "Nueva Reserva Creada", "Cita Pagada", etc.
        textoEstadoTooltip =
          lineas.find(
            (l) =>
              /reserva/i.test(l) ||
              /pagada/i.test(l) ||
              /cancelada/i.test(l),
          ) || null;
      }

      // 3) Parsear fecha y hora
      const fechaPart = parseFechaDesdeTooltip(lineaFecha);

      // Hora: priorizamos la del tooltip si existe, si no la del card
      const horaBase = lineaHorasTooltip || baseData.horaInicioRaw || '';
      let horaInicioStr = null;

      if (horaBase) {
        // si viene "8:45 am - 9:00 am" reclamamos solo la parte inicial
        const partes = horaBase.split('-').map((s) => s.trim());
        horaInicioStr = partes[0] || null;
      }

      const appointmentAt =
        fechaPart && horaInicioStr
          ? buildAppointmentDate(fechaPart, horaInicioStr)
          : null;

      if (!appointmentAt) {
        console.warn(
          `⚠️ No se pudo construir appointmentAt para cliente ${baseData.cliente}, tooltipFecha=${lineaFecha}, hora=${horaInicioStr}`,
        );
      }

      const fechaTexto =
        appointmentAt != null ? formatFechaBonita(appointmentAt) : null;

      // 4) Estado
      const Estado = mapEstadoFromText(textoEstadoTooltip);

      // 5) Celular: lo guardamos como número si se puede
      let celularValue = null;
      if (celular && /^\d{10}$/.test(celular)) {
        celularValue = parseInt(celular, 10);
      }

      // 6) Documento final
      const citaDoc = {
        Cliente: baseData.cliente,
        Celular: celularValue || null,
        Servicio: baseData.servicio,
        Especialista: baseData.especialista,
        Hora: horaInicioStr || baseData.horaInicioRaw || null,
        Fecha: fechaTexto,
        Estado,
        appointmentAt: appointmentAt || null,
        Sede: DEFAULT_SEDE,
        Usuario: DEFAULT_USUARIO,
        bgColor: baseData.bgColor,
        lastSyncedAt: new Date(),
      };

      // 7) Upsert en Mongo
      const filter = {
        Cliente: citaDoc.Cliente,
        Servicio: citaDoc.Servicio,
        Hora: citaDoc.Hora,
        Fecha: citaDoc.Fecha,
      };

      await appointmentsCol.updateOne(filter, { $set: citaDoc }, { upsert: true });
      processed += 1;
    } catch (err) {
      console.error('❌ Error procesando una cita:', err.message);
    }
  }

  // Log resumen
  const totalDocs = await appointmentsCol.countDocuments();
  const ejemplo = await appointmentsCol.findOne({}, { sort: { lastSyncedAt: -1 } });

  console.log(`📦 Total documentos en la colección: ${totalDocs}`);
  console.log('🔎 Ejemplo desde Mongo:', ejemplo);

  return processed;
}

// ===================== SYNC UNA VEZ (SEMANA ACTUAL + siguiente si sábado) =====================
async function syncOnce(page, appointmentsCol) {
  // 1) Semana actual
  const countCur = await syncVisibleWeek(page, appointmentsCol);
  console.log(`✅ Sincronización con Lizto (semana actual) completada. Citas procesadas: ${countCur}`);

  const hoy = new Date();
  const esSabado = hoy.getDay() === 6; // 6 = sábado

  if (esSabado) {
    try {
      console.log('📆 Hoy es sábado: sincronizando también la semana siguiente...');

      // Click en flecha de siguiente semana
      await page.click(
        'button.py-0.ivu-btn.ivu-btn-default span strong.mx-2 i.fa-angle-right',
      );
      await sleep(2000);

      const countNext = await syncVisibleWeek(page, appointmentsCol);
      console.log(
        `✅ Sincronización de la semana siguiente completada. Citas procesadas: ${countNext}`,
      );
    } catch (err) {
      console.error('❌ Error intentando sincronizar la semana siguiente:', err.message);
    }
  }

  console.log('⏱️ Dejando sincronización cada 30 minutos activa...');
}

// ===================== MAIN =====================
async function main() {
  console.log('[dotenv] .env cargado, iniciando Lizto-sync...');

  // Conexión a Mongo
  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);
  const appointmentsCol = db.collection(APPOINTMENTS_COL);
  console.log(`✅ Conectado a MongoDB (${DB_NAME})`);

  // Lanzar navegador
  const browser = await puppeteer.launch({
  headless: true,              // importante en servidor
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
});

  const page = await browser.newPage();

  try {
    await loginLizto(page);

    // Primera sincronización inmediata
    await syncOnce(page, appointmentsCol);

    // Luego cada 30 minutos
    setInterval(async () => {
      try {
        await syncOnce(page, appointmentsCol);
      } catch (err) {
        console.error('❌ Error en sincronización periódica:', err.message);
      }
    }, 60 * 60 * 1000);

    // Mantener el proceso vivo
  } catch (err) {
    console.error('❌ Error en lizto-sync:', err);
    await browser.close();
    await mongoClient.close();
    process.exit(1);
  }

  // Manejo de Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\n🛑 Cerrando lizto-sync...');
    await browser.close();
    await mongoClient.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('❌ Error global en main:', err);
  process.exit(1);
});
