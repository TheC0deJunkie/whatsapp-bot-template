import type { HandlerContext } from '../core/types.js';
import { sendMainMenu } from '../menus/main.js';

/**
 * Example: Stateful multi-step flow.
 *
 * Demonstrates the core pattern:
 * 1. Action match on idle → enter flow, set botStatus
 * 2. Status match on subsequent messages → process input
 * 3. Return true if handled, false to pass to next handler
 *
 * Flow: order_status action → ask for order ID → show status → done
 */
export async function handleOrderFlow(
  ctx: HandlerContext,
): Promise<boolean> {
  const { status, action, text, phone, send } = ctx;

  // ── Entry point: user selects "Order Status" from menu ────
  if (action === 'order_status' && status === 'idle') {
    await ctx.setState({ botStatus: 'waiting_order_id' });
    await send.sendText(phone, 'Please enter your order ID (e.g. ORD-1234):');
    return true;
  }

  // ── Waiting for order ID input ────────────────────────────
  if (status === 'waiting_order_id' && text) {
    // Cancel check
    if (text.toLowerCase() === 'cancel') {
      await ctx.setState({ botStatus: 'idle' });
      await sendMainMenu(ctx);
      return true;
    }

    const orderId = text.trim().toUpperCase();

    // Validate format (example)
    if (!/^ORD-\d+$/.test(orderId)) {
      await send.sendText(
        phone,
        'Invalid format. Please enter an order ID like ORD-1234, or type *cancel* to go back.',
      );
      return true;
    }

    // --- Replace with your actual order lookup ---
    const order = lookupOrder(orderId);

    if (!order) {
      await send.sendText(
        phone,
        `Order *${orderId}* not found. Try again or type *cancel*.`,
      );
      return true;
    }

    // Show order status and return to idle
    await send.sendText(
      phone,
      `📦 *Order ${orderId}*\n\nStatus: ${order.status}\nETA: ${order.eta}\n\nAnything else?`,
    );
    await ctx.setState({ botStatus: 'idle' });
    await sendMainMenu(ctx);
    return true;
  }

  return false;
}

// ── Fake order lookup (replace with your DB/API call) ─────────

function lookupOrder(id: string) {
  const orders: Record<string, { status: string; eta: string }> = {
    'ORD-1234': { status: '🚚 Shipped', eta: 'Tomorrow by 5pm' },
    'ORD-5678': { status: '📦 Processing', eta: '2-3 business days' },
    'ORD-9999': { status: '✅ Delivered', eta: 'Delivered on Monday' },
  };
  return orders[id] || null;
}
