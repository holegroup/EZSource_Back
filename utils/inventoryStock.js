import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Inventory from '../models/Inventory.js';
import Notification from '../models/Notification.js';
import { sendLowStockAlertEmail } from './mailer.js';
import { getStaffEmails } from './staffEmails.js';

export const DESIGN_TYPE_TO_SKU = {
  business_card: 'BC-PREM',
  letterhead: 'LH-CORP',
  envelope: 'EV-PROF',
  notepad: 'NP-DESG',
  folder: 'FL-PRES',
  slip: 'CS-COMP',
};

const parseLeadingInt = (value, fallback = 0) => {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const quantityFromDesignDetails = (designType, designDetails = {}) => {
  if (designDetails.orderQuantity) {
    return Math.max(1, parseLeadingInt(designDetails.orderQuantity, 1));
  }

  const type = designType || 'business_card';
  if (type === 'business_card' && designDetails.pricingOption) {
    const match = String(designDetails.pricingOption).match(/(\d+)\s+cards/i);
    if (match) return parseInt(match[1], 10);
  }
  if (type === 'letterhead') return Math.max(1, parseLeadingInt(designDetails.reams, 50));
  if (type === 'notepad') return Math.max(1, parseLeadingInt(designDetails.pads, 50));
  if (type === 'envelope' || type === 'folder' || type === 'slip') {
    return Math.max(1, parseLeadingInt(designDetails.boxes, 10));
  }
  return 100;
};

export const resolveProduct = async (item = {}, designType) => {
  if (item.product && mongoose.Types.ObjectId.isValid(item.product)) {
    const byId = await Product.findById(item.product);
    if (byId) return byId;
  }

  const sku = item.sku || DESIGN_TYPE_TO_SKU[designType] || DESIGN_TYPE_TO_SKU.business_card;
  if (sku) {
    const bySku = await Product.findOne({ sku });
    if (bySku) return bySku;
  }

  return null;
};

export const findInventoryForProduct = async (product) => {
  if (!product?._id) return null;
  return Inventory.findOne({ product: product._id }).populate('product');
};

export const notifyLowStockIfNeeded = async (inventory) => {
  if (!inventory) return;
  const available = Number(inventory.quantityAvailable ?? 0);
  const rawThreshold = Number(inventory.reorderPoint);
  const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 100;
  const isLow = available <= threshold;

  if (!isLow) {
    console.log(`[INVENTORY] Low-stock email skipped. Remaining ${available} is above reorder point ${threshold}.`);
    return;
  }

  const product = inventory.product?.name ? inventory.product : await inventory.populate('product');
  const productDoc = product.product || product;
  const adminEmails = await getStaffEmails(['super_user', 'inventory_admin', 'it_administrator']);
  console.log(`[INVENTORY] Low stock (${available} <= ${threshold}). Emailing: ${adminEmails.join(', ') || 'NONE'}`);

  if (!adminEmails.length) {
    console.error('[INVENTORY] No admin emails found for low-stock alert.');
    return;
  }

  await sendLowStockAlertEmail({
    adminEmails,
    productName: productDoc?.name,
    sku: productDoc?.sku,
    quantityAvailable: available,
    reorderPoint: threshold,
    warehouseLocation: inventory.warehouseLocation,
  });

  await Notification.create({
    title: 'Low Stock Alert',
    message: `${productDoc?.name || 'A product'} is at ${available} units (reorder point ${threshold}). Please increase quantity.`,
    type: 'inventory_update',
    targetRole: 'super_user',
  });
};

export const deductStock = async ({ product, quantity, reason = 'order' }) => {
  const qty = Math.max(0, Number(quantity) || 0);
  if (!product || qty <= 0) {
    return { deducted: 0, inventory: null };
  }

  let inventory = await findInventoryForProduct(product);
  if (!inventory) {
    inventory = await Inventory.create({
      product: product._id,
      warehouseLocation: 'Main Warehouse',
      quantityAvailable: 0,
      reorderPoint: 100,
      lastStockedAt: new Date(),
    });
    inventory = await inventory.populate('product');
  }

  const previousQty = Number(inventory.quantityAvailable || 0);
  const deducted = Math.min(previousQty, qty);
  inventory.quantityAvailable = Math.max(0, previousQty - qty);
  await inventory.save();

  console.log(
    `[INVENTORY] Deducted ${qty} (applied ${previousQty - inventory.quantityAvailable}) from ${product.sku || product._id} for ${reason}. Remaining: ${inventory.quantityAvailable}`
  );

  try {
    await notifyLowStockIfNeeded(inventory);
  } catch (err) {
    console.error('Failed to send low stock alert:', err);
  }

  return { deducted: previousQty - inventory.quantityAvailable, inventory, previousQty };
};
