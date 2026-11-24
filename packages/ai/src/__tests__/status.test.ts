import { describe, expect, it } from 'vitest';

import { describeStatus } from '../status.ts';

/**
 * Odmowa dostawcy przetłumaczona na radę.
 *
 * Najważniejsze są tu przeciążony model (prawdziwa awaria w ExpeditionPlan: Google odmówił jednemu
 * wariantowi, a wyglądało to na zepsutą funkcję) i zły klucz, który Google zgłasza kodem 400.
 */

describe('describeStatus', () => {
  it('przeciążony model nazywa po imieniu i proponuje inny', () => {
    const message = describeStatus(
      'GEMINI',
      503,
      'This model is currently experiencing high demand.',
      'gemini-3.5-flash',
    );

    expect(message).toContain('gemini-3.5-flash');
    expect(message).toContain('Google');
    expect(message).toContain('inny model');
  });

  it('zły klucz (u Google: 400 INVALID_ARGUMENT) nazywa złym kluczem, a nie złym zapytaniem', () => {
    expect(describeStatus('GEMINI', 400, 'API key not valid. Please pass a valid API key.', 'gemini-3.5-flash-lite')).toBe(
      'Nieprawidłowy klucz Gemini — skopiuj go jeszcze raz w całości z AI Studio.',
    );
  });

  it('wyczerpany limit to limit projektu użytkownika', () => {
    expect(describeStatus('GEMINI', 429, 'Resource exhausted', 'gemini-3.5-flash-lite')).toContain('Twój projekt');
  });

  it('przy liście modeli, gdzie nazwy jeszcze nie ma, mówi o samym dostawcy', () => {
    expect(describeStatus('GEMINI', 503, 'high demand', '')).toBe(
      'Gemini chwilowo nie odpowiada. Spróbuj później.',
    );
  });

  it('awarii serwera nie nazywa przeciążeniem', () => {
    expect(describeStatus('GEMINI', 500, 'internal error', 'gemini-test')).toBe(
      'Gemini chwilowo nie odpowiada. Spróbuj później.',
    );
  });

  it('nieważny klucz zostaje nieważnym kluczem', () => {
    expect(describeStatus('GEMINI', 403, 'Permission denied', 'gemini-3.5-flash')).toBe(
      'Klucz do Gemini jest nieważny albo bez uprawnień.',
    );
  });

  it('nieistniejący model odsyła po listę', () => {
    const message = describeStatus('GEMINI', 404, 'not found', 'gemini-wymyslony');

    expect(message).toContain('gemini-wymyslony');
    expect(message).toContain('listę modeli');
  });

  it('wycofany wariant podaje następcę, którego wskazał sam dostawca', () => {
    const message = describeStatus(
      'GEMINI',
      404,
      'This model models/gemini-2.5-flash is no longer available to new users. Please update your'
        + ' code to use models/gemini-3.8-flash for the latest features.',
      'gemini-2.5-flash',
    );

    expect(message).toContain('gemini-3.8-flash');
    expect(message).toContain('Google');
  });

  it('nie podaje jako następcy tego samego modelu, o który pytaliśmy', () => {
    const message = describeStatus(
      'GEMINI',
      404,
      'models/gemini-wymyslony is not found for API version v1beta',
      'gemini-wymyslony',
    );

    expect(message).toContain('Pobierz listę modeli');
  });
});
