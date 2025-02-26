

const { PDFDocument, rgb } = require('pdf-lib');
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const app = express();
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();
const crypto = require("crypto");
const axios = require("axios");
const QRCode = require("qrcode");


const pool = new Pool({
    user: 'postgres',

    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});



app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://campusly-ng.netlify.app"
  ],
  credentials: true, // If using cookies or authentication
  methods: ["GET", "POST", "PUT", "DELETE"]
}));


app.use(express.json());


// Middleware to authenticate and extract user data
const authenticateUser = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied' });
  
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded; // Add user data to request object
      console.log('Decoded user:', req.user); // Log the decoded user data
      next();
    } catch (err) {
      res.status(400).json({ error: 'Invalid token' });
    }
};


// **Signup Route**
app.post("/signup", async (req, res) => {
  const { username, email, password, role, bank_name, account_number, account_name } = req.body;

  try {
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    let bankDetails = role === "organizer" ? [bank_name, account_number, account_name] : [null, null, null];
    let subaccountId = null;

    // If the role is "organizer", create a Paystack sub-account
    if (role === "organizer") {
      const paystackResponse = await axios.post(
        "https://api.paystack.co/subaccount",
        {
          business_name: account_name,
          settlement_bank: bank_name,
          account_number: account_number,
          percentage_charge: 10, // Adjust charge percentage if needed
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
            "Content-Type": "application/json",
          },
        }
      );

      subaccountId = paystackResponse.data.data.subaccount_code;
    }

    // Insert user into the database
    const result = await pool.query(
      `INSERT INTO users (username, email, password, role, bank_name, account_number, account_name, subaccount_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING id, role, subaccount_id`,
      [username, email, hashedPassword, role, ...bankDetails, subaccountId]
    );

    // Generate JWT token
    const token = jwt.sign(
      { userId: result.rows[0].id, role: result.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ token, role: result.rows[0].role, subaccount_id: result.rows[0].subaccount_id });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(400).json({ error: err.message });
  }
});



  // **Login Route**
app.post("/login", async (req, res) => {
    const { email, password } = req.body;
  
    try {
      // Check if the user exists by email
      const user = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
      if (user.rows.length === 0) return res.status(404).json({ error: "User not found" });
  
      // Compare the provided password with the stored hashed password
      const validPassword = await bcrypt.compare(password, user.rows[0].password);
      if (!validPassword) return res.status(401).json({ error: "Invalid password" });
  
      // Generate the JWT token including the userId and role
      const token = jwt.sign(
        { userId: user.rows[0].id, role: user.rows[0].role }, // Include role in JWT payload
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
      );
  
      // Respond with the token and the user's role
      res.json({ token, role: user.rows[0].role });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  


// Get all events
app.get('/events', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM events');
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Error fetching events' });
    }
});
// Get event details
app.get('/events/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Fetch event by ID, including JSONB details and ticket information
    const event = await pool.query(
      `SELECT id, title, date, location, category, image_url, description, 
              organizer, price, details, total_tickets, tickets_sold, organizer_subaccount, 
              (total_tickets - tickets_sold) AS tickets_remaining 
       FROM events 
       WHERE id = $1`,
      [id]
    );

    if (event.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Return event details with ticket information
    res.json(event.rows[0]);
  } catch (err) {
    console.error('Error fetching event details:', err.message);
    res.status(500).json({ error: 'Error fetching event details' });
  }
});






app.post('/events', authenticateUser, async (req, res) => {
  const { title, description, date, time, location, image_url, category, organizer, price, total_tickets } = req.body;
  const userId = req.user?.userId;

  try {
    if (!userId) return res.status(401).json({ error: 'Unauthorized: User ID missing.' });

    // Get user's subaccount_id
    const userResult = await pool.query('SELECT subaccount_id FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found.' });

    const subaccountId = userResult.rows[0].subaccount_id;

    // Insert event with total_tickets
    const event = await pool.query(
      'INSERT INTO events (title, description, date, time, user_id, location, image_url, category, organizer, price, organizer_subaccount, total_tickets) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *',
      [
        title,
        description,
        date,
        time,
        userId,
        location,
        image_url,
        category,
        organizer,
        price,
   
        subaccountId,
        total_tickets
      ]
    );

    res.status(201).json(event.rows[0]);
  } catch (err) {
    console.error('Error creating event:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


app.get('/profile', authenticateUser, async (req, res) => {
    try {
      const user = await pool.query('SELECT id, username, email FROM users WHERE id = $1', [req.user.userId]);
      if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      res.json(user.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch user profile' });
    }
  });

  app.put('/profile/update', authenticateUser, async (req, res) => {
    const { username, email } = req.body;
    try {
      const result = await pool.query(
        'UPDATE users SET username = $1, email = $2 WHERE id = $3 RETURNING *',
        [username, email, req.user.userId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ message: 'Profile updated successfully!', user: result.rows[0] });
    } catch (err) {
      console.error('Update Error:', err.message); // Log the error
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });
  

  // Fetch bank details
app.get('/bank-details', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT bank_name, account_number, account_name FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bank details not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bank details' });
  }
});

app.put('/bank-details/update', authenticateUser, async (req, res) => {
  const { bank_name, account_name, account_number } = req.body;

  try {
    // Fetch the user's current subaccount ID
    const user = await pool.query('SELECT subaccount_id FROM users WHERE id = $1', [req.user.userId]);
    const subaccountId = user.rows[0]?.subaccount_id;

    if (!subaccountId) {
      return res.status(400).json({ error: 'Subaccount ID not found. Only organizers have bank details.' });
    }

    // Update subaccount on Paystack
    const paystackResponse = await axios.put(
      `https://api.paystack.co/subaccount/${subaccountId}`,
      {
        business_name: account_name,
        settlement_bank: bank_name,
        account_number: account_number,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!paystackResponse.data.status) {
      return res.status(400).json({ error: 'Failed to update Paystack subaccount' });
    }

    // Update the database
    const result = await pool.query(
      'UPDATE users SET bank_name = $1, account_name = $2, account_number = $3 WHERE id = $4 RETURNING *',
      [bank_name, account_name, account_number, req.user.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'Bank details updated successfully!', user: result.rows[0] });
  } catch (err) {
    console.error('Update Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to update bank details and sync with Paystack' });
  }
});




  app.post("/events/register/:eventId", authenticateUser, async (req, res) => {
    const { eventId } = req.params;
    const { name, email, phone } = req.body;
    const userId = req.user?.userId;

    if (!eventId || !name || !email || !phone || !userId) {
        return res.status(400).json({ error: "All fields are required, including user ID." });
    }

    try {
        // Check if user is already registered
        const checkQuery = `SELECT * FROM event_registrations WHERE event_id = $1 AND user_id = $2;`;
        const existingRegistration = await pool.query(checkQuery, [eventId, userId]);

        if (existingRegistration.rows.length > 0) {
            return res.status(409).json({ error: "You are already registered for this event." });
        }

        // Fetch event details
        const eventQuery = `SELECT title, date, time, location FROM events WHERE id = $1;`;
        const eventResult = await pool.query(eventQuery, [eventId]);

        if (eventResult.rows.length === 0) {
            return res.status(404).json({ error: "Event not found." });
        }

        const eventDetails = eventResult.rows[0];

        // Insert new registration
        const registrationQuery = `
            INSERT INTO event_registrations (event_id, user_id, name, email, phone)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
        `;
        const registrationValues = [eventId, userId, name, email, phone];
        const registrationResult = await pool.query(registrationQuery, registrationValues);
        const registration = registrationResult.rows[0];

        // Generate unique ticket code
        const ticketCode = `TKT-${crypto.randomBytes(6).toString("hex")}`;

        // Store event details in JSON format
        const eventDetailsJson = JSON.stringify({
            title: eventDetails.title,
            date: eventDetails.date,
            time: eventDetails.time,
            location: eventDetails.location,
        });

        // Insert ticket into tickets table with event details
        const ticketQuery = `
            INSERT INTO tickets (event_id, user_id, ticket_code, event_details, name, email, phone)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *;
        `;
        const ticketValues = [eventId, userId, ticketCode, eventDetailsJson, name, email, phone];
        const ticketResult = await pool.query(ticketQuery, ticketValues);
        const ticket = ticketResult.rows[0];

        // Generate QR code for the ticket
        const qrData = {
            ticketId: ticket.id,
            ticketCode: ticketCode,
            eventId: eventId,
            name: name,
            email: email,
            eventDetails: eventDetailsJson,
        };

        const qrCodeUrl = await QRCode.toDataURL(JSON.stringify(qrData));
       await pool.query('UPDATE events SET tickets_sold = tickets_sold + 1 WHERE id = $1;', [eventId]);

        res.status(201).json({
            message: "Registration successful. Ticket generated.",
            registration,
            ticket: {
                ...ticket,
                qrCode: qrCodeUrl, // Attach QR code to response
            },
        });

    } catch (err) {
        console.error("Error during registration:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});
// Route to verify ticket
app.get("/verify-ticket/:eventId/:ticketCode", async (req, res) => {
  const { eventId, ticketCode } = req.params;

  try {
    const ticketQuery = "SELECT * FROM tickets WHERE ticket_code = $1;";
    const ticketResult = await pool.query(ticketQuery, [ticketCode]);

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Ticket not found" });
    }

    const ticket = ticketResult.rows[0];

    if (ticket.event_id !== parseInt(eventId)) {
      return res.status(400).json({ success: false, error: "Ticket does not belong to this event!" });
    }

    if (ticket.used) {
      return res.status(400).json({ success: false, error: "Ticket already used!" });
    }

    // Mark ticket as used
    await pool.query("UPDATE tickets SET used = TRUE WHERE ticket_code = $1;", [ticketCode]);

    return res.json({
      success: true,
      message: "Ticket is valid!",
      ticket: {
        eventId: ticket.event_id,
        name: ticket.name,
        title: ticket.event_details?.title,
        email: ticket.email,
        ticketCode: ticket.ticket_code,
      },
    });
  } catch (error) {
    console.error("Error verifying ticket:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});



app.post("/subaccount", async (req, res) => {
  const { business_name, bank_name, account_number } = req.body;

  if (!business_name || !bank_name || !account_number) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    // Step 1: Get Bank Code from Paystack
    const banksResponse = await axios.get("https://api.paystack.co/bank", {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` },
    });

    const bank = banksResponse.data.data.find((b) => b.name.toLowerCase() === bank_name.toLowerCase());
    if (!bank) return res.status(400).json({ message: "Invalid bank name" });

    // Step 2: Create Subaccount
    const subaccountResponse = await axios.post(
      "https://api.paystack.co/subaccount",
      {
        business_name,
        settlement_bank: bank.code,
        account_number,
        percentage_charge: 10, 
      },
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` },
      }
    );

    const subaccount_code = subaccountResponse.data.data.subaccount_code;

    // Step 3: Save to Database
    await pool.query("INSERT INTO organizers (business_name, bank_name, account_number, subaccount_code) VALUES ($1, $2, $3, $4)", 
      [business_name, bank_name, account_number, subaccount_code]);

    res.json({ message: "Subaccount created successfully", subaccount_code });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ message: "Error creating subaccount" });
  }
});



// Fetch registered events for current user
app.get("/attendee/events", authenticateUser, async (req, res) => {
  const userId = req.user?.userId; // Extract user ID from token

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  try {
    const query = `
      SELECT e.id, e.title, e.description, e.date, e.location, e.time
      FROM event_registrations er
      JOIN events e ON er.event_id = e.id
      WHERE er.user_id = $1;
    `;
    const values = [userId];
    const result = await pool.query(query, values);

    res.status(200).json({
      events: result.rows,
    });
  } catch (err) {
    console.error("Error fetching registered events:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get Attendee Tickets (all tickets)
app.get('/attendee/tickets', authenticateUser, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(400).json({ error: 'User ID is required' });

    const result = await pool.query(
      `SELECT ticket_code, event_id, issued_at, event_details
       FROM tickets WHERE user_id = $1`,
      [userId]
    );

    res.json({ tickets: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});



// Get Ticket for a Specific Event
app.get('/attendee/tickets/:eventId', authenticateUser, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const eventId = req.params.eventId;

    if (!userId) return res.status(400).json({ error: 'User ID is required' });
    if (!eventId) return res.status(400).json({ error: 'Event ID is required' });

    const result = await pool.query(
      `SELECT ticket_code, event_id, issued_at, event_details
       FROM tickets WHERE user_id = $1 AND event_id = $2`,
      [userId, eventId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found for this event' });
    }

    const ticket = result.rows[0];

    // Generate QR code
    const qrCodeData = JSON.stringify({
      ticket_code: ticket.ticket_code,
      event_id: ticket.event_id,
      user_id: userId,
    });

    const qrCode = await QRCode.toDataURL(qrCodeData); // Generate QR code as a data URL

    // Add QR code to the ticket response
    ticket.qrCode = qrCode;

    res.json({ ticket, event: ticket });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get("/organizer/events", authenticateUser, async (req, res) => {
  const userId = req.user?.userId; // Extract user ID from token

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  try {
    const query = `
      SELECT id, title, description, time, date, location, category, price, image_url, organizer, total_tickets
      FROM events
      WHERE user_id = $1;
    `;
    const values = [userId];
    const result = await pool.query(query, values);

    res.status(200).json({
      events: result.rows,
    });
  } catch (err) {
    console.error("Error fetching organizer events:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});



// Ensure user ID is passed and exists
app.get('/events/count', async (req, res) => {
  const userId = req.user?.id; // Ensure `req.user` exists
  console.log("User ID:", req.user?.id);

  if (!userId) {
      return res.status(400).json({ error: "User ID is required." });
  }
  try {
      const totalEvents = await Event.count({ where: { createdBy: userId } });
      res.json({ totalEvents });
  } catch (error) {
      res.status(500).json({ error: "Failed to fetch events." });
  }
});

// Get the total number of attendees for all events
app.get('/events/attendees', async (req, res) => {
  const userId = req.user?.id;
  try {
      const events = await Event.findAll({ where: { createdBy: userId } });
      console.log(events);
      const totalAttendees = events.reduce((sum, event) => sum + event.attendees, 0);
      res.json({ totalAttendees });
  } catch (error) {
      res.status(500).json({ error: 'Failed to fetch total attendees.' });
  }
});

// Route to fetch total events
app.get("/analytics/total-events", authenticateUser, async (req, res) => {
  const userId = req.user?.userId;

  try {
    if (!userId) {
      return res.status(400).json({ error: "User ID is missing" });
    }

    const result = await pool.query(
      "SELECT COUNT(*) AS total_events FROM events WHERE user_id = $1",
      [userId]
    );

    res.json({ totalEvents: parseInt(result.rows[0].total_events) });
  } catch (err) {
    console.error("Error in /analytics/total-events:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


// Route to get total registrations
app.get('/events/registrations/total', authenticateUser, async (req, res) => {
  try {
    const userId = req.user?.userId; // Extract user ID from middleware
    console.log('User ID:', userId); 
      const query = `
          SELECT 
              COUNT(er.id) AS total_registrations
          FROM 
              events e
          LEFT JOIN 
              event_registrations er ON e.id = er.event_id
          WHERE 
              e.user_id = $1;
      `;
      const { rows } = await pool.query(query, [userId]);
      res.status(200).json({ totalRegistrations: rows[0].total_registrations });
  } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch total registrations' });
  }
});


app.get('/revenue/total', authenticateUser, async (req, res) => {
  try {
    const userId = req.user?.userId; // Extract user ID from middleware
    console.log('User ID:', userId); 

    const query = `
        SELECT 
            COALESCE(SUM(er.amount_paid), 0) AS total_revenue
        FROM 
            events e
        LEFT JOIN 
            event_registrations er ON e.id = er.event_id
        WHERE 
            e.user_id = $1
            AND er.amount_paid > 0;
    `;

    const { rows } = await pool.query(query, [userId]);
    res.status(200).json({ totalRevenue: rows[0].total_revenue });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch total revenue' });
  }
});


// Backend route to get registrations for a specific event
app.get("/events/:eventId/registrations/count", async (req, res) => {
  const { eventId } = req.params;

  try {
    // Query the database to count registrations for the event
    const result = await pool.query(
      `SELECT COUNT(*) FROM event_registrations WHERE event_id = $1`,
      [eventId]
    );

    // Return the count
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


app.get("/events/:eventId/revenue", async (req, res) => {
  const { eventId } = req.params;

  try {
    // Query the database to sum the revenue for the event
    const result = await pool.query(
      `SELECT COALESCE(SUM(amount_paid), 0) AS total_revenue 
FROM event_registrations 
WHERE event_id = $1;
`,
      [eventId]
    );

    // Return the total revenue
    res.json({ revenue: result.rows[0].total_revenue });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// Search events
app.get('/events/search/:query', async (req, res) => {
    const { query } = req.params;
    try {
        const events = await pool.query(
            'SELECT * FROM events WHERE title ILIKE $1 OR description ILIKE $1',
            [`%${query}%`]
        );
        res.json(events.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Error searching events' });
    }
});

// Get paginated events
app.get('/events/page/:page', async (req, res) => {
    const { page } = req.params;
    const limit = 10; // Number of events per page
    const offset = (page - 1) * limit;

    try {
        const events = await pool.query('SELECT * FROM events ORDER BY date LIMIT $1 OFFSET $2', [limit, offset]);
        res.json(events.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Error fetching paginated events' });
    }
});

// Edit an existing event (PATCH)
app.put('/events/:id', async (req, res) => {
  const { id } = req.params;
  const { title, description, date, location, image_url, category,  price, details, organizer, total_tickets} = req.body;

  try {
      const updatedEvent = await pool.query(
          `UPDATE events 
           SET title = $1, description = $2, date = $3, location = $4, image_url = $5, 
               category = $6,  price = $7, details = $8 , organizer = $9, total_tickets = $10
           WHERE id = $11 RETURNING *`,
          [title, description, date, location, image_url, category, price, JSON.stringify(details), organizer , total_tickets, id]
      );

      if (updatedEvent.rowCount === 0) {
          return res.status(404).json({ error: 'Event not found' });
      }

      res.status(200).json(updatedEvent.rows[0]);
  } catch (err) {
      console.error('Error updating event:', err.message);
      res.status(500).json({ error: 'Error updating event' });
  }
});



app.delete('/events/:id', async (req, res) => {
  const { id } = req.params;
  
  const ticketCount = await pool.query(
    `SELECT COUNT(*) FROM tickets WHERE event_id = $1`,
    [id]
  );

  if (ticketCount.rows[0].count > 0) {
    return res.status(403).json({
      message: "Event cannot be deleted because tickets have been sold. Please reschedule instead.",
    });
  }

  await pool.query(`DELETE FROM events WHERE id = $1`, [id]);
  res.json({ message: "Event deleted successfully." });
});



// Get all events (GET)
app.get('/events', async (req, res) => {
  try {
      const events = await pool.query('SELECT * FROM events ORDER BY date DESC');
      res.status(200).json(events.rows);
  } catch (err) {
      console.error('Error fetching events:', err.message);
      res.status(500).json({ error: 'Error fetching events' });
  }
});

app.post("/verify-payment", authenticateUser, async (req, res) => {
  const userId = req.user?.userId;
  const { reference, eventId, userDetails } = req.body;
  const { name, email, phone } = userDetails;

  if (!reference || !eventId || !name || !email || !phone || !userId) {
    return res.status(400).json({ error: "All fields are required, including user ID." });
  }

  try {
    // Verify payment with Paystack
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` },
    });

    if (response.data.data.status !== "success") {
      return res.status(400).json({ message: "Payment verification failed." });
    }

    const amountPaid = response.data.data.amount / 100; // Convert from kobo to Naira

    // Check if user is already registered
    const checkQuery = `SELECT * FROM event_registrations WHERE event_id = $1 AND user_id = $2;`;
    const existingRegistration = await pool.query(checkQuery, [eventId, userId]);

    if (existingRegistration.rows.length > 0) {
      return res.status(409).json({ error: "You are already registered for this event." });
    }

    // Fetch event details
    const eventQuery = `SELECT title, date, location FROM events WHERE id = $1;`;
    const eventResult = await pool.query(eventQuery, [eventId]);

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: "Event not found." });
    }

    const eventDetails = eventResult.rows[0];

    // Insert new registration with amount paid
    const registrationQuery = `
      INSERT INTO event_registrations (event_id, user_id, name, email, phone, amount_paid, payment_status)
      VALUES ($1, $2, $3, $4, $5, $6, 'paid')
      RETURNING *;
    `;
    const registrationValues = [eventId, userId, name, email, phone, amountPaid];
    const registrationResult = await pool.query(registrationQuery, registrationValues);
    const registration = registrationResult.rows[0];

    // Generate unique ticket code
    const ticketCode = `TKT-${crypto.randomBytes(6).toString("hex")}`;

    // Store event details in JSON format
    const eventDetailsJson = JSON.stringify({
      title: eventDetails.title,
      date: eventDetails.date,
      location: eventDetails.location,
    });

    // Insert ticket into tickets table
    const ticketQuery = `
      INSERT INTO tickets (event_id, user_id, ticket_code, event_details, name, email, phone)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const ticketValues = [eventId, userId, ticketCode, eventDetailsJson, name, email, phone];
    const ticketResult = await pool.query(ticketQuery, ticketValues);
    const ticket = ticketResult.rows[0];

    // Generate QR code for the ticket
    const qrData = {
      ticketId: ticket.id,
      ticketCode: ticketCode,
      eventId: eventId,
      name: name,
      email: email,
      eventDetails: eventDetailsJson,
    };

    const qrCodeUrl = await QRCode.toDataURL(JSON.stringify(qrData));

    // Update the event's tickets_sold count
    await pool.query("UPDATE events SET tickets_sold = tickets_sold + 1 WHERE id = $1;", [eventId]);

    res.status(201).json({
      message: "Payment verified and ticket generated successfully.",
      registration,
      ticket: {
        ...ticket,
        qrCode: qrCodeUrl, // Attach QR code to response
      },
    });
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});



// Check if user is already registered for the event
app.get('/check-registration', authenticateUser, async (req, res) => {
  const { eventId } = req.query;
  const userId = req.user?.userId;

  try {
    const checkQuery = 'SELECT * FROM event_registrations WHERE event_id = $1 AND user_id = $2';
    const existingRegistration = await pool.query(checkQuery, [eventId, userId]);

    if (existingRegistration.rows.length > 0) {
      return res.status(409).json({ error: "You are already registered for this event." });
    }

    return res.status(200).json({ message: "User not registered. Proceed to payment." });
  } catch (error) {
    console.error("Error checking registration:", error);
    return res.status(500).json({ error: "Something went wrong." });
  }
});


// Start the server
app.listen(3000, () => {
    console.log('Server is running on port 3000');
});


