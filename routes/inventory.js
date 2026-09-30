import express from 'express';
import Inventory from '../models/Inventory.js';
import { protect, restrictTo } from '../middleware/auth.js';
import { notifyLowStockIfNeeded } from '../utils/inventoryStock.js';
import { sendStockOrderEmail } from '../utils/mailer.js';
import { getStaffEmails } from '../utils/staffEmails.js';

const STOCK_ADMINS = ['super_user', 'inventory_admin'];

const parsePositiveInt = (value) => {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount <= 0) return null;
  return amount;
};

const router = express.Router();

// @desc    Get all inventory items
// @route   GET /api/v1/inventory
// @access  Private (super_user, inventory_admin, procurement)
router.get(
  '/',
  protect,
  restrictTo('super_user', 'inventory_admin', 'procurement', 'user'),
  async (req, res) => {
    try {
      const inventory = await Inventory.find().populate('product', 'name sku category');
      res.json({
        success: true,
        count: inventory.length,
        data: inventory,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// @desc    Add stock or initialize product inventory
// @route   POST /api/v1/inventory/add-stock
// @access  Private (super_user, inventory_admin)
router.post(
  '/add-stock',
  protect,
  restrictTo('super_user', 'inventory_admin'),
  async (req, res) => {
    try {
      const { productId, quantity, warehouseLocation, reorderPoint = 100 } = req.body;

      if (!productId || quantity === undefined) {
        return res.status(400).json({ success: false, error: 'Product ID and quantity are required.' });
      }

      let item = await Inventory.findOne({ product: productId });

      if (item) {
        item.quantityAvailable += Number(quantity);
        item.lastStockedAt = new Date();
        if (warehouseLocation) {
          item.warehouseLocation = warehouseLocation;
        }
      } else {
        if (!warehouseLocation) {
          return res.status(400).json({ success: false, error: 'Warehouse location is required for new inventory items.' });
        }
        item = new Inventory({
          product: productId,
          warehouseLocation,
          quantityAvailable: Number(quantity),
          reorderPoint,
          lastStockedAt: new Date(),
        });
      }

      await item.save();
      const populatedItem = await item.populate('product', 'name sku');

      res.status(200).json({
        success: true,
        data: populatedItem,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// @desc    Adjust inventory level
// @route   POST /api/v1/inventory/adjust-stock
// @access  Private (super_user, inventory_admin)
router.post(
  '/adjust-stock',
  protect,
  restrictTo('super_user', 'inventory_admin'),
  async (req, res) => {
    try {
      const { inventoryId, quantity, notes } = req.body;

      const item = await Inventory.findById(inventoryId);
      if (!item) {
        return res.status(404).json({ success: false, error: 'Inventory record not found.' });
      }

      item.quantityAvailable = Number(quantity);
      await item.save();

      const populatedItem = await item.populate('product', 'name sku');
      await notifyLowStockIfNeeded(populatedItem);
      res.json({
        success: true,
        data: populatedItem,
        notes,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// @desc    Increase stock by a positive amount
// @route   POST /api/v1/inventory/increase-stock
// @access  Private (super_user, inventory_admin)
router.post(
  '/increase-stock',
  protect,
  restrictTo(...STOCK_ADMINS),
  async (req, res) => {
    try {
      const { inventoryId } = req.body;
      const amount = parsePositiveInt(req.body.amount);

      if (!inventoryId || amount === null) {
        return res.status(400).json({
          success: false,
          error: 'Inventory ID and a positive whole-number amount are required.',
        });
      }

      const item = await Inventory.findById(inventoryId);
      if (!item) {
        return res.status(404).json({ success: false, error: 'Inventory record not found.' });
      }

      item.quantityAvailable = Number(item.quantityAvailable || 0) + amount;
      item.lastStockedAt = new Date();
      await item.save();

      const populatedItem = await item.populate('product', 'name sku category');
      res.json({
        success: true,
        message: `Increased stock by ${amount}.`,
        data: populatedItem,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// @desc    Decrease stock by a positive amount
// @route   POST /api/v1/inventory/decrease-stock
// @access  Private (super_user, inventory_admin)
router.post(
  '/decrease-stock',
  protect,
  restrictTo(...STOCK_ADMINS),
  async (req, res) => {
    try {
      const { inventoryId } = req.body;
      const amount = parsePositiveInt(req.body.amount);

      if (!inventoryId || amount === null) {
        return res.status(400).json({
          success: false,
          error: 'Inventory ID and a positive whole-number amount are required.',
        });
      }

      const item = await Inventory.findById(inventoryId);
      if (!item) {
        return res.status(404).json({ success: false, error: 'Inventory record not found.' });
      }

      const available = Number(item.quantityAvailable || 0);
      if (amount > available) {
        return res.status(400).json({
          success: false,
          error: `Cannot decrease by ${amount}. Only ${available} units are available.`,
        });
      }

      item.quantityAvailable = available - amount;
      await item.save();

      const populatedItem = await item.populate('product', 'name sku category');
      await notifyLowStockIfNeeded(populatedItem);
      res.json({
        success: true,
        message: `Decreased stock by ${amount}.`,
        data: populatedItem,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// @desc    Email a stock replenishment order
// @route   POST /api/v1/inventory/order-stock
// @access  Private (super_user, inventory_admin)
router.post(
  '/order-stock',
  protect,
  restrictTo(...STOCK_ADMINS),
  async (req, res) => {
    try {
      const { inventoryId, note, recipientEmail } = req.body;
      const orderQuantity = parsePositiveInt(req.body.quantity);

      if (!inventoryId || orderQuantity === null) {
        return res.status(400).json({
          success: false,
          error: 'Inventory ID and a positive whole-number order quantity are required.',
        });
      }

      const extraRecipient = String(recipientEmail || '').trim();
      if (extraRecipient && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extraRecipient)) {
        return res.status(400).json({ success: false, error: 'Enter a valid recipient email address.' });
      }

      const item = await Inventory.findById(inventoryId).populate('product', 'name sku');
      if (!item) {
        return res.status(404).json({ success: false, error: 'Inventory record not found.' });
      }

      const staffEmails = await getStaffEmails(['super_user', 'inventory_admin', 'procurement']);
      const recipients = [...staffEmails];
      if (extraRecipient) recipients.push(extraRecipient.toLowerCase());
      const uniqueRecipients = [...new Set(recipients)];

      if (!uniqueRecipients.length) {
        return res.status(400).json({
          success: false,
          error: 'No recipient email is configured. Add an address or set ADMIN_EMAIL.',
        });
      }

      const product = item.product || {};
      await sendStockOrderEmail({
        recipients: uniqueRecipients,
        productName: product.name,
        sku: product.sku,
        quantityAvailable: item.quantityAvailable,
        reorderPoint: item.reorderPoint,
        warehouseLocation: item.warehouseLocation,
        orderQuantity,
        note: String(note || '').trim(),
        requestedBy: req.user?.fullName || req.user?.email,
      });

      res.json({
        success: true,
        message: `Stock order email sent to ${uniqueRecipients.join(', ')}.`,
        recipients: uniqueRecipients,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

export default router;
