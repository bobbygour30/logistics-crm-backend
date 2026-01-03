// index.js - Fixed for Vercel Serverless Functions (Express-style app exported)

const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { nanoid } = require('nanoid');

dotenv.config();

// Use a global cached client to avoid reconnecting on every request (important for serverless)
let cachedClient = null;
let cachedDb = null;

const uri = process.env.MONGO_URI;

async function connectToDatabase() {
  if (cachedDb) return cachedDb;

  if (!cachedClient) {
    cachedClient = new MongoClient(uri, {
      // Recommended settings for serverless
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 20000,
    });
    await cachedClient.connect();
    console.log('Connected to MongoDB Atlas');
  }

  cachedDb = cachedClient.db('ticketdb');
  return cachedDb;
}

// Create Express app
const app = express();

// Middleware
app.use(cors({
  origin: '*', // Adjust for production (e.g., your frontend domain)
}));
app.use(express.json());

// Global error handler (good practice)
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// POST /api/create-ticket
app.post('/api/create-ticket', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const body = req.body;

    if (!body.customer_name || !body.ticket_title) {
      return res.status(400).json({ error: 'customer_name and ticket_title are required' });
    }

    const customerData = {
      name: body.customer_name.trim(),
      email: body.customer_email?.trim() || null,
      phone: body.customer_phone?.trim() || null,
      company_name: body.customer_company_name?.trim() || null,
      address: body.customer_address?.trim() || null,
      created_at: new Date().toISOString(),
    };

    let customer;

    if (customerData.email) {
      await db.collection('customers').updateOne(
        { email: customerData.email },
        { $set: customerData },
        { upsert: true }
      );

      customer = await db.collection('customers').findOne({ email: customerData.email });
    } else {
      const insertResult = await db.collection('customers').insertOne(customerData);
      customer = { _id: insertResult.insertedId, ...customerData };
    }

    if (!customer || !customer._id) {
      throw new Error('Failed to create or retrieve customer');
    }

    const ticket_number = 'TKT-' + nanoid(8).toUpperCase();

    const ticketData = {
      ticket_number,
      customer_id: customer._id,
      title: body.ticket_title.trim(),
      description: body.ticket_description?.trim() || null,
      type: body.ticket_type || 'inquiry',
      status: 'open',
      priority: body.ticket_priority || 'medium',
      tracking_number: body.tracking_number?.trim() || null,
      source: body.source || 'api',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      closed_at: null,
      assigned_to: null,
    };

    const ticketResult = await db.collection('tickets').insertOne(ticketData);

    const responseTicket = {
      id: ticketResult.insertedId.toString(),
      ticket_number: ticketData.ticket_number,
      customer_id: customer._id.toString(),
      assigned_to: null,
      title: ticketData.title,
      description: ticketData.description,
      type: ticketData.type,
      status: ticketData.status,
      priority: ticketData.priority,
      source: ticketData.source,
      tracking_number: ticketData.tracking_number,
      created_at: ticketData.created_at,
      updated_at: ticketData.updated_at,
      closed_at: null,
      customers: {
        id: customer._id.toString(),
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        company_name: customer.company_name,
        address: customer.address,
        created_at: customer.created_at,
      },
      agents: null,
    };

    res.json({ success: true, ticket: responseTicket });
  } catch (err) {
    console.error('Create ticket error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /api/tickets
app.get('/api/tickets', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const tickets = await db.collection('tickets')
      .aggregate([
        {
          $lookup: {
            from: 'customers',
            localField: 'customer_id',
            foreignField: '_id',
            as: 'customers'
          }
        },
        { $unwind: { path: '$customers', preserveNullAndEmptyArrays: true } },
        { $sort: { created_at: -1 } }
      ])
      .toArray();

    const formattedTickets = tickets.map(ticket => ({
      id: ticket._id.toString(),
      ticket_number: ticket.ticket_number,
      customer_id: ticket.customer_id?.toString() || null,
      assigned_to: ticket.assigned_to || null,
      title: ticket.title,
      description: ticket.description,
      type: ticket.type,
      status: ticket.status,
      priority: ticket.priority,
      source: ticket.source,
      tracking_number: ticket.tracking_number,
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      closed_at: ticket.closed_at,
      customers: ticket.customers ? {
        id: ticket.customers._id.toString(),
        name: ticket.customers.name,
        email: ticket.customers.email,
        phone: ticket.customers.phone,
        company_name: ticket.customers.company_name,
        address: ticket.customers.address,
        created_at: ticket.customers.created_at,
      } : null,
      agents: null,
    }));

    res.json({ tickets: formattedTickets });
  } catch (err) {
    console.error('Error fetching tickets:', err);
    res.status(500).json({ error: 'Failed to fetch tickets', details: err.message });
  }
});

// GET /api/agents
app.get('/api/agents', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const agents = await db.collection('agents').find({ is_active: true })
      .sort({ name: 1 })
      .toArray();

    const formatted = agents.map(a => ({
      id: a._id.toString(),
      name: a.name,
      email: a.email,
      role: a.role,
      is_active: a.is_active,
      created_at: a.created_at,
    }));

    res.json({ agents: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch agents', details: err.message });
  }
});

// GET /api/tickets/:id/comments
app.get('/api/tickets/:id/comments', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const comments = await db.collection('ticket_comments')
      .aggregate([
        { $match: { ticket_id: new ObjectId(req.params.id) } },
        {
          $lookup: {
            from: 'agents',
            localField: 'agent_id',
            foreignField: '_id',
            as: 'agents'
          }
        },
        { $unwind: { path: '$agents', preserveNullAndEmptyArrays: true } },
        { $sort: { created_at: -1 } }
      ])
      .toArray();

    const formatted = comments.map(c => ({
      id: c._id.toString(),
      ticket_id: c.ticket_id.toString(),
      agent_id: c.agent_id?.toString() || null,
      comment: c.comment,
      is_internal: c.is_internal,
      created_at: c.created_at,
      agents: c.agents ? {
        id: c.agents._id.toString(),
        name: c.agents.name,
        email: c.agents.email,
        role: c.agents.role,
      } : null,
    }));

    res.json({ comments: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch comments', details: err.message });
  }
});

// POST /api/tickets/:id/comments
app.post('/api/tickets/:id/comments', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { comment, is_internal = false, agent_id = null } = req.body;

    const result = await db.collection('ticket_comments').insertOne({
      ticket_id: new ObjectId(req.params.id),
      agent_id: agent_id ? new ObjectId(agent_id) : null,
      comment: comment.trim(),
      is_internal,
      created_at: new Date().toISOString(),
    });

    res.json({ success: true, comment_id: result.insertedId.toString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add comment', details: err.message });
  }
});

// PATCH /api/tickets/:id
app.patch('/api/tickets/:id', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const updates = req.body;

    if (updates.assigned_to === '') updates.assigned_to = null;

    const result = await db.collection('tickets').updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          ...updates,
          updated_at: new Date().toISOString(),
          ...(updates.status === 'closed' && { closed_at: new Date().toISOString() }),
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update ticket', details: err.message });
  }
});

// GET /api/customers
app.get('/api/customers', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const customers = await db.collection('customers')
      .find({})
      .sort({ name: 1 })
      .toArray();

    const formatted = customers.map(c => ({
      id: c._id.toString(),
      name: c.name,
      email: c.email,
      phone: c.phone,
      company_name: c.company_name,
      address: c.address,
      created_at: c.created_at,
    }));

    res.json({ customers: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch customers', details: err.message });
  }
});

// GET /api/open-tickets
app.get('/api/open-tickets', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const tickets = await db.collection('tickets')
      .aggregate([
        { $match: { status: { $in: ['open', 'working'] } } },
        {
          $lookup: {
            from: 'customers',
            localField: 'customer_id',
            foreignField: '_id',
            as: 'customers'
          }
        },
        { $unwind: { path: '$customers', preserveNullAndEmptyArrays: true } },
        { $sort: { created_at: -1 } },
        { $limit: 20 }
      ])
      .toArray();

    const formatted = tickets.map(t => ({
      id: t._id.toString(),
      ticket_number: t.ticket_number,
      title: t.title,
      status: t.status,
      customers: t.customers ? {
        id: t.customers._id.toString(),
        name: t.customers.name,
      } : null,
    }));

    res.json({ tickets: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tickets', details: err.message });
  }
});

// POST /api/ivr-calls
app.post('/api/ivr-calls', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const data = req.body;

    if (!data.phone_number || !data.call_duration || !data.call_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await db.collection('ivr_calls').insertOne({
      customer_id: data.customer_id ? new ObjectId(data.customer_id) : null,
      ticket_id: data.ticket_id ? new ObjectId(data.ticket_id) : null,
      phone_number: data.phone_number.trim(),
      call_duration: Number(data.call_duration),
      call_type: data.call_type,
      notes: data.notes || null,
      created_at: new Date().toISOString(),
    });

    res.json({ success: true, call_id: result.insertedId.toString() });
  } catch (err) {
    console.error('IVR call error:', err);
    res.status(500).json({ error: 'Failed to log IVR call', details: err.message });
  }
});

// Export the app for Vercel serverless
module.exports = app;