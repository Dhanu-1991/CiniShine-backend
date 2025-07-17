const paymentWebhook = async (req, res) => {
  console.log("Webhook triggered:", req.body);

  const event = req.body.event;
  const orderId = req.body.data?.order?.order_id;

  if (!event || !orderId) {
    return res.status(400).json({ error: "Invalid webhook payload" });
  }

  // Example: Update payment status in DB (you can customize this)
  console.log(`✅ Webhook Event Received: ${event} for Order: ${orderId}`);

  // Cashfree expects 200 OK to confirm receipt
  res.status(200).send("Webhook received");
};

export default paymentWebhook;
