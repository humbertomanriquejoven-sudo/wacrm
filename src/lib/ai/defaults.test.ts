import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiTimeZone,
  buildSystemPrompt,
  currentDateTimeContext,
  todayContextLine,
} from './defaults';

const REAL_TZ = process.env.AI_TIMEZONE;

beforeEach(() => {
  process.env.AI_TIMEZONE = 'America/Bogota';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  if (REAL_TZ === undefined) {
    delete process.env.AI_TIMEZONE;
  } else {
    process.env.AI_TIMEZONE = REAL_TZ;
  }
});

describe('currentDateTimeContext', () => {
  it('computes the wall-clock in the business timezone', () => {
    // 2026-09-14T12:00:00Z = 07:00 in America/Bogota (UTC-5, no DST).
    expect(aiTimeZone()).toBe('America/Bogota');
    expect(currentDateTimeContext()).toEqual({
      weekday: 'lunes',
      date: '2026-09-14',
      time: '07:00',
    });
  });

  it('defaults to America/Bogota when AI_TIMEZONE is unset', () => {
    delete process.env.AI_TIMEZONE;
    expect(aiTimeZone()).toBe('America/Bogota');
  });
});

describe('todayContextLine', () => {
  it('emits the fixed Spanish header with weekday, YYYY-MM-DD and 24h HH:MM', () => {
    expect(todayContextLine()).toBe(
      'INFORMACIÓN DE FECHA Y HORA ACTUAL: Hoy es lunes, 2026-09-14, hora local 07:00 (America/Bogota)'
    );
  });
});

describe('buildSystemPrompt', () => {
  it('prepends the today line as the opening instruction', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft' });

    const [first] = prompt.split('\n\n');
    expect(first).toBe(
      'INFORMACIÓN DE FECHA Y HORA ACTUAL: Hoy es lunes, 2026-09-14, hora local 07:00 (America/Bogota)'
    );
    expect(prompt).toContain(
      'Eres un asistente de mensajería al cliente para un negocio'
    );
  });

  it('forces Spanish-only replies', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(prompt).toContain('responde SIEMPRE en español');
    expect(prompt).toContain(
      'está estrictamente prohibido responder en inglés'
    );
  });

  it('never teaches an automatic handoff and demands a reply to every message', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    // CERO handoff automático: el inline no instruye el sentinel y ninguna
    // conversación puede quedar en visto.
    expect(prompt).not.toContain('[[HANDOFF]]');
    expect(prompt).not.toContain('responde exactamente con');
    expect(prompt).toContain('ninguna conversación debe quedar en visto');
    expect(prompt).toContain('responder SIEMPRE en español a cada mensaje');
  });

  it('orders direct booking in the same turn once the customer gave a date', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain('EL AGENDAMIENTO DIRECTO ES OBLIGATORIO');
    expect(prompt).toContain('NO vuelvas a preguntar la fecha');
    expect(prompt).toContain(
      'nunca detengas el flujo para preguntar el motivo'
    );
    expect(prompt).toContain('confirmado: true');
    expect(prompt).toContain('un correo faltante nunca debe bloquear la cita');
  });

  it('forces immediate booking when the customer shares their email', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain('AGENDAMIENTO INMEDIATO AL RECIBIR EL CORREO');
    expect(prompt).toContain(
      'Cuando el usuario te entregue su correo electrónico y tengas la fecha y hora seleccionadas, invoca inmediatamente la función para agendar en Google Calendar.'
    );
    expect(prompt).toContain(
      "Aquí tienes tu enlace para unirte a la videollamada: [LINK]"
    );
  });

  it('instructs a WhatsApp notification when Google Calendar creation fails', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain('COMPENSACIÓN ANTE FALLOS DE GOOGLE CALENDAR');
    expect(prompt).toContain('NUNCA te quedes en silencio');
    expect(prompt).toContain(
      'un asesor le enviará el enlace de Google Meet en breve'
    );
  });

  it('forbids re-asking for the date range in the confirmation protocol', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(prompt).toContain(
      'No debes pedirle a un cliente que ya confirmó una fecha y/o hora'
    );
    expect(prompt).toContain('"Consulta / Valoración"');
  });

  it('teaches single-point availability as a 45-minute range', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain(
      'ver_disponibilidad acepta también una hora puntual'
    );
    expect(prompt).toContain(
      'nunca respondas que no puedes verificar una hora puntual'
    );
  });

  it('forbids inventing Meet/calendar URLs and trusts the configured credentials', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain('PROHIBIDO inventar URLs');
    expect(prompt).toContain('meet.google.com/xxx-yyyy-zzz');
    expect(prompt).toContain('Confía plenamente en que las credenciales');
    expect(prompt).toContain('ejecuta el tool_call directamente');
  });

  it('forces the mandatory Meet link in every booking confirmation', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain('REGLA OBLIGATORIA DE CONFIRMACIÓN DE CITA');
    expect(prompt).toContain('Enlace de Google Meet OBLIGATORIO');
    expect(prompt).toContain('FORMATO EXIGIDO');
    expect(prompt).toContain('Puedes unirte a la videollamada');
    expect(prompt).toContain('NUNCA omitas el enlace de Google Meet');
    expect(prompt).toContain('vuelve a enviarle la URL completa');
  });

  it('enforces the golden scheduling rules (tool-before-confirmation, hangoutLink, no raw timestamps)', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain('REGLAS DE ORO DEL AGENDAMIENTO');
    expect(prompt).toContain('NUNCA confirmes una cita sin invocar la herramienta');
    expect(prompt).toContain('DEBES llamar a `ver_disponibilidad`');
    expect(prompt).toContain('extrae OBLIGATORIAMENTE la URL que devuelve la herramienta');
    expect(prompt).toContain('Unirse a Google Meet: [hangoutLink]');
    expect(prompt).toContain('17:32:11 -05:00');
  });

  it('forces strict Spanish and a single response without internal reasoning', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain('español natural y profesional');
    expect(prompt).toContain('UNA SOLA respuesta');
    expect(prompt).toContain('chain of thought');
    expect(prompt).toContain('razonamiento interno');
    expect(prompt).toContain('SALIDA DIRIGIDA AL CLIENTE');
    expect(prompt).toContain('Pensamiento:');
    expect(prompt).toContain('nota de voz');
  });
});
