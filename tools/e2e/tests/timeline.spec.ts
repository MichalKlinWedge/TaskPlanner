/** Oś czasu (Etap 6, M12): przesunięcie paska zadania o dwa dni (skala „Dzień”, 30 px na dzień). */
import { addDays } from '@taskplanner/core';

import { E2E_TIMELINE_TASK } from '../src/constants.ts';
import { center, drag } from '../src/drag.ts';
import { expect, openApp, test } from '../src/fixtures.ts';

test('pasek przesunięty o dwa dni zmienia daty zadania', async ({ page, server }) => {
  const before = await server.waitForTask(E2E_TIMELINE_TASK);
  await openApp(page, '#/timeline');
  const timeline = page.getByTestId('timeline');
  await timeline.getByRole('group', { name: 'Skala' }).getByRole('button', { name: 'Dzień', exact: true }).click();
  const bar = timeline.locator('.wx-bar').filter({ hasText: E2E_TIMELINE_TASK });
  await expect(bar).toBeVisible();

  const from = await center(bar);
  await drag(page, from, { x: from.x + 60, y: from.y });
  const moved = await server.waitForTask(E2E_TIMELINE_TASK, (t) => t.due_date !== before.due_date);
  expect(moved).toMatchObject({ start_date: addDays(before.start_date!, 2), due_date: addDays(before.due_date!, 2) });
  await expect(page.getByText(`Nowe daty „${E2E_TIMELINE_TASK}”`)).toBeVisible();
});
