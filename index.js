const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK with Environment Variables from Render
admin.initializeApp({
  credential: admin.credential.cert({
    "project_id": process.env.PROJECT_ID,
    "private_key": process.env.PRIVATE_KEY?.replace(/\\n/g, '\n'),
    "client_email": process.env.CLIENT_EMAIL,
  })
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Knock Knock Server is running!');
});

// Endpoint to send knock notifications
app.post('/knock', async (req, res) => {
  try {
    const { token } = req.body; // Get the token from the request

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const message = {
      data: {
        type: 'knock',
        title: 'Knock Knock!',
        message: 'Someone is at your door!'
      },
      token: token
    };

    const response = await admin.messaging().send(message);
    console.log('Knock sent successfully:', response);
    res.json({ success: true, messageId: response });

  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});