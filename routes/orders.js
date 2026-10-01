import express from 'express';
import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Notification from '../models/Notification.js';
import CustomizeConfig from '../models/CustomizeConfig.js';
import { protect, restrictTo } from '../middleware/auth.js';
import User from '../models/User.js';
import { sendInvoiceEmail, sendOrderPlacedEmails, sendOrderStatusEmails } from '../utils/mailer.js';
import { getStaffEmails } from '../utils/staffEmails.js';
import { deductStock, resolveProduct } from '../utils/inventoryStock.js';
import { withFormattedPhone } from '../utils/phone.js';

const buildInvoiceDetails = (order) => {
  const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();
  const dueDate = new Date(createdAt.getTime() + 14 * 24 * 60 * 60 * 1000);
  return {
    invoiceNumber: `INV-${String(order.orderNumber || '').replace(/^ORD-/, '')}`,
    orderNumber: order.orderNumber,
    amount: order.total,
    subtotal: order.subtotal,
    tax: order.tax,
    shipping: order.shipping,
    status: order.paymentStatus === 'paid' ? 'paid' : 'sent',
    issueDate: createdAt.toISOString().slice(0, 10),
    dueDate: dueDate.toISOString().slice(0, 10),
    customerName: order.customer?.fullName || '',
    customerEmail: order.customer?.email || '',
    billToAddress: order.delivery?.addressChangeStatus === 'approved' && order.delivery?.requestedAddress
      ? order.delivery.requestedAddress
      : order.delivery?.storeAddress || order.delivery?.pickupAddress || '',
    items: (order.items || []).map((item) => ({
      name: item.product?.name || item.name || 'Print item',
      quantity: item.quantity || 1,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
    })),
  };
};

const emailInvoiceToCustomerAndAdmin = async (order, { reason } = {}) => {
  const invoiceDetails = buildInvoiceDetails(order);
  const customerEmail = order.customer?.email;
  if (customerEmail) {
    await sendInvoiceEmail(customerEmail, invoiceDetails, { reason });
  } else {
    console.error(`[INVOICE] Order ${order.orderNumber} has no customer email.`);
  }

  const adminEmails = (await getStaffEmails(['super_user'])).filter(
    (email) => email !== String(customerEmail || '').toLowerCase()
  );
  if (adminEmails.length) {
    await sendInvoiceEmail(adminEmails, invoiceDetails, { audience: 'admin', reason });
  }
};

const emailInvoiceAfterDelivery = async (orderId) => {
  try {
    const order = await Order.findById(orderId)
      .populate('customer', 'fullName email')
      .populate('items.product', 'name');
    if (!order) return;
    await emailInvoiceToCustomerAndAdmin(order, { reason: 'delivered' });
  } catch (err) {
    console.error('Failed to send delivery invoice emails:', err);
  }
};

const emailOrderUpdate = async (order, previousStatus, newStatus, extraNote) => {
  try {
    let customerEmail = order.customer?.email;
    let customerName = order.customer?.fullName;
    if (!customerEmail) {
      const customer = await User.findById(order.customer).select('email fullName');
      customerEmail = customer?.email;
      customerName = customer?.fullName;
    }
    const adminEmails = await getStaffEmails(['super_user', 'order_processor']);
    await sendOrderStatusEmails({
      customerEmail,
      customerName,
      adminEmails,
      orderDetails: {
        orderNumber: order.orderNumber,
        total: order.total,
        status: order.status,
        items: order.items,
      },
      previousStatus,
      newStatus,
      extraNote,
    });
  } catch (err) {
    console.error('Failed to send order status emails:', err);
  }
};


const router = express.Router();

const getAddressChangeFee = async () => {
  const config = await CustomizeConfig.findOne().select('checkoutSettings.addressChangeFee');
  const fee = Number(config?.checkoutSettings?.addressChangeFee);
  return Number.isFinite(fee) && fee >= 0 ? fee : 15;
};

const isStoreFulfillment = (order) => (
  order.delivery?.fulfillmentType === 'store' ||
  String(order.delivery?.notes || '').includes('Store Pickup')
);

// @desc    Create a new order
// @route   POST /api/v1/orders
// @access  Private
router.post('/', protect, async (req, res) => {
  try {
    const { items, subtotal, tax, shipping, total } = req.body;
    const incomingDelivery = req.body.delivery || {};

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Please add items to your order.' });
    }

    const fulfillmentType = incomingDelivery.fulfillmentType === 'store' ? 'store' : 'shipping';
    const requestedAddress = String(incomingDelivery.requestedAddress || '').trim();
    const addressChangeRequested = incomingDelivery.addressChangeStatus === 'pending';
    if (fulfillmentType === 'store' && !String(incomingDelivery.pickupAddress || '').trim()) {
      return res.status(400).json({ success: false, error: 'Select a store. Store orders are delivered to the store address.' });
    }
    if (addressChangeRequested && !requestedAddress) {
      return res.status(400).json({ success: false, error: 'Enter the address you want instead of the store.' });
    }

    const storeLocationId = incomingDelivery.storeLocationId;
    let shippingAmount = Number(shipping) || 0;
    let orderTotal = Number(total) || 0;
    if (fulfillmentType === 'store' && shippingAmount > 0) {
      orderTotal = Math.max(0, Number((orderTotal - shippingAmount).toFixed(2)));
      shippingAmount = 0;
    }

    const delivery = {
      status: 'pending',
      notes: incomingDelivery.notes || '',
      pickupAddress: incomingDelivery.pickupAddress || '',
      fulfillmentType,
      storeLocationId: storeLocationId && mongoose.Types.ObjectId.isValid(storeLocationId) ? storeLocationId : null,
      storeName: incomingDelivery.storeName || '',
      storeAddress: incomingDelivery.storeAddress || '',
      requestedAddress: addressChangeRequested ? requestedAddress : '',
      addressChangeStatus: addressChangeRequested ? 'pending' : 'none',
      addressChangeFee: addressChangeRequested ? await getAddressChangeFee() : 0,
      addressChangeFeeApplied: false,
    };

    // Generate unique order number (e.g. ORD-YYYYMMDD-XXXX)
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const orderNumber = `ORD-${dateStr}-${randomSuffix}`;

    const resolvedItems = [];
    for (const item of items) {
      const product = await resolveProduct(item);
      if (!product) {
        return res.status(400).json({ success: false, error: `Product not found for ID/SKU: ${item.product || item.sku}` });
      }
      resolvedItems.push({
        ...item,
        product: product._id,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
        customization: withFormattedPhone(item.customization || {}),
        _resolvedProduct: product,
      });
    }

    for (const item of resolvedItems) {
      await deductStock({
        product: item._resolvedProduct,
        quantity: item.quantity,
        reason: `order ${orderNumber}`,
      });
    }

    const order = await Order.create({
      orderNumber,
      customer: req.user._id,
      items: resolvedItems.map(({ _resolvedProduct, ...item }) => item),
      subtotal,
      tax,
      shipping: shippingAmount,
      total: orderTotal,
      paymentStatus: req.body.paymentStatus || 'pending',
      allowedPaymentMethod: req.body.allowedPaymentMethod || 'none',
      status: 'pending',
      delivery
    });

    // Create Notification
    try {
      await Notification.create({
        title: 'New Order Placed',
        message: `${req.user.fullName} placed order ${orderNumber} for a total of $${order.total}.`,
        type: 'order_created',
        user: req.user._id,
        targetRole: 'super_user'
      });
      if (delivery.addressChangeStatus === 'pending') {
        await Notification.create({
          title: 'Store Address Change Requested',
          message: `${req.user.fullName} asked to deliver order ${orderNumber} to a custom address instead of the store. Fee on approval: $${delivery.addressChangeFee.toFixed(2)}.`,
          type: 'address_change',
          user: req.user._id,
          targetRole: 'super_user'
        });
      }
    } catch (notifErr) {
      console.error('Failed to create order notification:', notifErr);
    }

    try {
      const adminEmails = await getStaffEmails(['super_user', 'order_processor']);
      await sendOrderPlacedEmails({
        customerEmail: req.user.email,
        customerName: req.user.fullName,
        adminEmails,
        orderDetails: {
          orderNumber: order.orderNumber,
          total: order.total,
          status: order.status,
          items: order.items,
        },
      });
    } catch (err) {
      console.error('Failed to send order confirmation emails:', err);
    }

    res.status(201).json({
      success: true,
      data: order,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// @desc    Get all orders
// @route   GET /api/v1/orders
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    let query = {};

    // Standard users can only view their own orders
    if (req.user.role === 'user') {
      query.customer = req.user._id;
    }

    // Delivery persons can view orders assigned to them
    if (req.user.role === 'delivery_person') {
      query['delivery.deliveryPerson'] = req.user._id;
    }

    const { status, page = 1, limit = 10 } = req.query;
    if (status) {
      query.status = status;
    }

    const skipIndex = (page - 1) * limit;

    const orders = await Order.find(query)
      .populate('customer', 'fullName email')
      .populate('items.product', 'name sku')
      .limit(Number(limit))
      .skip(skipIndex)
      .sort({ createdAt: -1 });

    const total = await Order.countDocuments(query);

    res.json({
      success: true,
      count: orders.length,
      total,
      page: Number(page),
      limit: Number(limit),
      data: orders,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// @desc    Get order by ID
// @route   GET /api/v1/orders/:id
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('customer', 'fullName email phone')
      .populate('items.product', 'name sku basePrice')
      .populate('delivery.deliveryPerson', 'fullName email phone');

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    // Check ownership unless admin/staff
    if (
      req.user.role === 'user' &&
      order.customer._id.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({ success: false, error: 'You do not have permission to view this order.' });
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// @desc    Update order status
// @route   PUT /api/v1/orders/:id
// @access  Private (super_user, order_processor, delivery_person, accounting)
router.put('/:id', protect, async (req, res) => {
  try {
    const { status, paymentStatus, deliveryStatus, notes, allowedPaymentMethod, pickupAddress } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    // Authorization checks
    const allowedRoles = ['super_user', 'order_processor', 'delivery_person', 'accounting'];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'You do not have permission to edit orders.' });
    }

    if (req.user.role === 'delivery_person' && order.delivery.deliveryPerson?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: 'You can only update deliveries assigned to you.' });
    }

    const previousStatus = order.status;
    const previousPayment = order.paymentStatus;
    const previousDelivery = order.delivery?.status;

    // Process updates
    if (status) order.status = status;
    if (paymentStatus) order.paymentStatus = paymentStatus;
    if (allowedPaymentMethod) order.allowedPaymentMethod = allowedPaymentMethod;

    if (deliveryStatus) {
      order.delivery.status = deliveryStatus;
      if (deliveryStatus === 'delivered') {
        order.delivery.deliveredAt = new Date();
        order.status = 'delivered';
      }
    }

    if (notes !== undefined) {
      order.delivery.notes = notes;
    }

    if (pickupAddress !== undefined) {
      order.delivery.pickupAddress = pickupAddress;
    }

    await order.save();

    const statusChanged = Boolean(status && status !== previousStatus);
    const paymentChanged = Boolean(paymentStatus && paymentStatus !== previousPayment);
    const deliveryChanged = Boolean(deliveryStatus && deliveryStatus !== previousDelivery);
    if (statusChanged || paymentChanged || deliveryChanged) {
      const newStatus = deliveryStatus && deliveryStatus !== previousDelivery
        ? `delivery ${deliveryStatus}`
        : paymentChanged && !statusChanged
          ? `payment ${order.paymentStatus}`
          : order.status;
      emailOrderUpdate(order, previousStatus, newStatus);
    }

    if (order.status === 'delivered' && previousStatus !== 'delivered') {
      emailInvoiceAfterDelivery(order._id);
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// @desc    Assign order to delivery person
// @route   POST /api/v1/orders/:id/assign-delivery
// @access  Private (super_user, order_processor)
router.post(
  '/:id/assign-delivery',
  protect,
  restrictTo('super_user', 'order_processor'),
  async (req, res) => {
    try {
      const { deliveryPersonId, scheduledDate } = req.body;

      const order = await Order.findById(req.params.id);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Order not found.' });
      }

      order.delivery.deliveryPerson = deliveryPersonId;
      order.delivery.status = 'assigned';
      order.delivery.scheduledDate = scheduledDate ? new Date(scheduledDate) : null;

      const previousStatus = order.status;
      order.status = 'ready'; // Ready for dispatch

      await order.save();
      emailOrderUpdate(order, previousStatus, 'ready', 'A delivery person has been assigned.');

      res.json({
        success: true,
        data: order,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// @desc    Pay for an order
// @route   POST /api/v1/orders/:id/pay
// @access  Private (customer)
router.post('/:id/pay', protect, async (req, res) => {
  try {
    const { paymentMethod } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    // Check ownership unless admin
    if (order.customer.toString() !== req.user._id.toString() && req.user.role !== 'super_user') {
      return res.status(403).json({ success: false, error: 'You do not have permission to pay for this order.' });
    }

    if (order.paymentStatus === 'paid') {
      return res.status(400).json({ success: false, error: 'This order is already paid.' });
    }

    const previousStatus = order.status;
    order.paymentStatus = 'paid';
    order.delivery.notes = `${order.delivery.notes || ''}\n\n[PAID LATER] Paid via ${paymentMethod ? paymentMethod.toUpperCase() : 'selected method'} on ${new Date().toISOString()}`;

    await order.save();
    emailOrderUpdate(order, previousStatus, 'payment paid', `Paid via ${paymentMethod || 'selected method'}.`);

    res.json({
      success: true,
      message: 'Payment completed successfully.',
      data: order,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// @desc    Send invoice email to customer
// @route   POST /api/v1/orders/:id/send-invoice
// @access  Private (super_user, order_processor, accounting)
router.post('/:id/send-invoice', protect, restrictTo('super_user', 'order_processor', 'accounting'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('customer', 'fullName email')
      .populate('items.product', 'name');
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    await emailInvoiceToCustomerAndAdmin(order, {
      reason: order.status === 'delivered' ? 'delivered' : undefined,
    });

    res.json({
      success: true,
      message: `Invoice email sent to ${order.customer?.email || 'the customer'} and the admin.`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const customerOwnsOrder = (order, user) => (
  order.customer.toString() === user._id.toString() ||
  order.customer?._id?.toString() === user._id.toString()
);

// @desc    Customer asks to deliver a store order to a specific address
// @route   POST /api/v1/orders/:id/address-change
// @access  Private (order owner)
router.post('/:id/address-change', protect, async (req, res) => {
  try {
    const requestedAddress = String(req.body.requestedAddress || '').trim();
    if (!requestedAddress) {
      return res.status(400).json({ success: false, error: 'Enter the address you want instead of the store.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }
    if (!customerOwnsOrder(order, req.user)) {
      return res.status(403).json({ success: false, error: 'You can only change your own orders.' });
    }
    if (!isStoreFulfillment(order)) {
      return res.status(400).json({ success: false, error: 'Address changes apply when the order is set to a store.' });
    }
    if (['delivered', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ success: false, error: 'This order can no longer change its delivery address.' });
    }
    if (order.delivery.addressChangeStatus === 'pending') {
      return res.status(400).json({ success: false, error: 'An address change is already waiting for admin approval.' });
    }
    if (order.delivery.addressChangeStatus === 'approved') {
      return res.status(400).json({ success: false, error: 'This order was already changed to a specific address.' });
    }

    const fee = await getAddressChangeFee();
    order.delivery.fulfillmentType = 'store';
    order.delivery.requestedAddress = requestedAddress;
    order.delivery.addressChangeStatus = 'pending';
    order.delivery.addressChangeFee = fee;
    order.delivery.notes = `${order.delivery.notes || ''}\n\n[ADDRESS CHANGE REQUESTED — pending admin]\n${requestedAddress}\nFee on approval: $${fee.toFixed(2)}`;
    await order.save();

    try {
      await Notification.create({
        title: 'Store Address Change Requested',
        message: `${req.user.fullName} asked to deliver order ${order.orderNumber} to a custom address instead of the store. Fee on approval: $${fee.toFixed(2)}.`,
        type: 'address_change',
        user: req.user._id,
        targetRole: 'super_user'
      });
    } catch (notifErr) {
      console.error('Failed to create address change notification:', notifErr);
    }

    emailOrderUpdate(
      order,
      order.status,
      'address change requested',
      `Deliver to this address instead of the store:\n${requestedAddress}\nCharge on approval: $${fee.toFixed(2)}.`
    );

    res.json({ success: true, data: order });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// @desc    Admin approves or rejects a store-to-address change and applies the fee
// @route   POST /api/v1/orders/:id/address-change/review
// @access  Private (super_user, order_processor, accounting)
router.post(
  '/:id/address-change/review',
  protect,
  restrictTo('super_user', 'order_processor', 'accounting'),
  async (req, res) => {
    try {
      const action = req.body.action;
      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ success: false, error: 'Action must be approve or reject.' });
      }

      const order = await Order.findById(req.params.id);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Order not found.' });
      }
      if (order.delivery.addressChangeStatus !== 'pending') {
        return res.status(400).json({ success: false, error: 'There is no address change waiting for review.' });
      }

      if (action === 'reject') {
        order.delivery.addressChangeStatus = 'rejected';
        order.delivery.notes = `${order.delivery.notes || ''}\n\n[ADDRESS CHANGE REJECTED]\nRequested: ${order.delivery.requestedAddress}`;
        await order.save();
        emailOrderUpdate(order, order.status, 'address change rejected', 'The store address remains the delivery location.');
        return res.json({ success: true, data: order });
      }

      const address = String(req.body.address || order.delivery.requestedAddress || '').trim();
      if (!address) {
        return res.status(400).json({ success: false, error: 'A delivery address is required to approve the change.' });
      }
      const feeInput = req.body.fee !== undefined ? Number(req.body.fee) : Number(order.delivery.addressChangeFee);
      if (!Number.isFinite(feeInput) || feeInput < 0) {
        return res.status(400).json({ success: false, error: 'Enter a valid address change fee.' });
      }

      if (!order.delivery.addressChangeFeeApplied) {
        order.total = Number((Number(order.total) + feeInput).toFixed(2));
        order.delivery.addressChangeFeeApplied = true;
      }
      order.delivery.addressChangeFee = feeInput;
      order.delivery.requestedAddress = address;
      order.delivery.pickupAddress = address;
      order.delivery.addressChangeStatus = 'approved';
      order.delivery.notes = `${order.delivery.notes || ''}\n\n[ADDRESS CHANGE APPROVED]\nDeliver to: ${address}\nAddress change fee: $${feeInput.toFixed(2)}`;
      await order.save();
      emailOrderUpdate(
        order,
        order.status,
        'address change approved',
        `Delivery address is now:\n${address}\nAddress change fee: $${feeInput.toFixed(2)}.`
      );

      res.json({ success: true, data: order });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

export default router;

