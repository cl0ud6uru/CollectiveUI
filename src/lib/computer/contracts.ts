import { z } from 'zod';

export const ComputerInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), x: z.number().int().min(0).max(1279), y: z.number().int().min(0).max(799), button: z.enum(['left', 'right', 'middle']).optional() }).strict(),
  z.object({ kind: z.literal('type'), text: z.string().max(4000).refine(text => !/[\u0000-\u001f\u007f-\u009f]/.test(text), 'Use key events for control characters.') }).strict(),
  z.object({ kind: z.literal('key'), key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Control+a', 'Control+c', 'Control+v']) }).strict(),
  z.object({ kind: z.literal('scroll'), direction: z.enum(['up', 'down']), amount: z.number().int().min(1).max(10) }).strict(),
]);
export type ComputerInput = z.infer<typeof ComputerInputSchema>;

export const ComputerViewStatusSchema = z.object({
  available: z.boolean(), state: z.enum(['running', 'stopped', 'unavailable']),
  control: z.enum(['agent', 'you', 'other']), paused: z.boolean(), lastFrameAt: z.string().datetime().nullable(),
  width: z.literal(1280), height: z.literal(800), reason: z.string().max(256).optional(),
}).strict();
export type ComputerViewStatus = z.infer<typeof ComputerViewStatusSchema>;
