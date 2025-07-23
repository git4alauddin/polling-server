const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: [
            "http://localhost:3000",
            "https://live-polling-system-nu.vercel.app"
        ],
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    connectionStateRecovery: {
        maxDisconnectionDuration: 30000,
        skipMiddlewares: true
    }
});

// Configuration
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'teacher123';
const MAX_POLL_DURATION = 300; // 5 minutes maximum
const MAX_CHAT_HISTORY = 200; // Limit chat history size
const MESSAGE_RATE_LIMIT = 1000; // 1 second between messages

// Store application state
let activePoll = null;
let results = {};
let teacherSocket = null;
const connectedStudents = new Map(); // socket.id -> {name, lastMessageTime}
const answeredStudents = new Set(); // socket.id of students who answered
const chatMessages = [];
const messageRateLimits = new Map(); // socket.id -> lastMessageTime

// Helper functions
const calculatePercentages = () => {
    if (!activePoll) return {};

    const total = Object.values(results).reduce((sum, val) => sum + val, 0);
    return activePoll.options.reduce((acc, option) => {
        acc[option] = Math.round(((results[option] || 0) / (total || 1)) * 100);
        return acc;
    }, {});
};

const broadcastStudentList = () => {
    const students = Array.from(connectedStudents.values()).map(s => s.name);
    io.emit('student-list-updated', students);
};

const broadcastChatMessage = (message) => {
    // Ensure message is properly formatted
    const formattedMessage = {
        sender: message.sender,
        text: message.text.substring(0, 500), // Limit message length
        timestamp: message.timestamp || new Date().toISOString(),
        isSystem: message.isSystem || false
    };

    io.emit('chat-message', formattedMessage);
    chatMessages.push(formattedMessage);

    // Keep chat history manageable
    if (chatMessages.length > MAX_CHAT_HISTORY) {
        chatMessages.shift();
    }
};

const checkAllStudentsAnswered = () => {
    return connectedStudents.size > 0 && 
           answeredStudents.size === connectedStudents.size;
};

const validateStudentName = (name) => {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    return trimmed.length >= 2 && trimmed.length <= 20;
};

const isRateLimited = (socketId) => {
    const now = Date.now();
    const lastMessageTime = messageRateLimits.get(socketId) || 0;
    return (now - lastMessageTime) < MESSAGE_RATE_LIMIT;
};

// Socket.io connection handler
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    // Debug all events (development only)
    if (process.env.NODE_ENV === 'development') {
        socket.onAny((event, ...args) => {
            console.log(`[${socket.id}] ${event}`, args.length ? args : '');
        });
    }

    // Handle teacher authentication
    socket.on('identify-teacher', (password, callback) => {
        try {
            if (password === TEACHER_PASSWORD) {
                teacherSocket = socket.id;
                socket.isTeacher = true;
                console.log(`Teacher identified: ${socket.id}`);

                // Send current state to teacher
                const stateUpdate = {
                    activePoll,
                    results: activePoll ? calculatePercentages() : {},
                    participation: {
                        answered: answeredStudents.size,
                        total: connectedStudents.size
                    },
                    chatHistory: chatMessages,
                    students: Array.from(connectedStudents.values()).map(s => s.name)
                };

                socket.emit('teacher-state-update', stateUpdate);

                if (typeof callback === 'function') {
                    callback({ status: 'success' });
                }
            } else {
                console.warn(`Failed teacher authentication attempt from ${socket.id}`);
                if (typeof callback === 'function') {
                    callback({ error: 'Invalid credentials' });
                }
            }
        } catch (error) {
            console.error('Error in teacher authentication:', error);
            if (typeof callback === 'function') {
                callback({ error: 'Authentication failed' });
            }
        }
    });

    // Handle student registration
    socket.on('register-student', (data, callback) => {
        try {
            const { name } = data || {};
            
            if (!validateStudentName(name)) {
                return callback?.({ error: 'Invalid student name (2-20 characters required)' });
            }

            const studentName = name.trim();

            // Check if name is already taken
            if (Array.from(connectedStudents.values()).some(s => s.name === studentName)) {
                return callback?.({ error: 'Name already in use' });
            }

            connectedStudents.set(socket.id, { 
                name: studentName,
                joinedAt: new Date().toISOString()
            });
            
            console.log(`Student registered: ${studentName} (${socket.id})`);

            // Notify all clients
            broadcastStudentList();
            broadcastChatMessage({
                sender: 'System',
                text: `${studentName} joined the classroom`,
                isSystem: true
            });

            // Send current state to student
            const studentState = {
                activePoll,
                results: activePoll ? calculatePercentages() : {},
                participation: {
                    answered: answeredStudents.size,
                    total: connectedStudents.size
                },
                chatHistory: chatMessages
            };
            socket.emit('student-state-update', studentState);

            callback?.({ status: 'success' });
        } catch (error) {
            console.error('Error in student registration:', error);
            callback?.({ error: 'Registration failed' });
        }
    });

    // Handle poll creation
    socket.on('create-poll', (poll, callback) => {
        try {
            // Authorization check
            if (!socket.isTeacher || socket.id !== teacherSocket) {
                console.warn(`Unauthorized poll creation attempt from ${socket.id}`);
                return callback?.({ error: 'Unauthorized' });
            }

            // Check if there's an active poll with unanswered students
            if (activePoll && answeredStudents.size < connectedStudents.size) {
                return callback?.({
                    error: 'Cannot create new poll - current poll still active with unanswered students',
                    status: 'pending',
                    answered: answeredStudents.size,
                    total: connectedStudents.size
                });
            }

            // Validation
            if (!poll?.question || !Array.isArray(poll.options) || poll.options.length < 2) {
                const error = 'Invalid poll data: question and at least 2 options required';
                console.warn(error);
                return callback?.({ error });
            }

            // Prepare new poll
            const newPoll = {
                question: poll.question.trim(),
                options: poll.options
                    .filter(opt => typeof opt === 'string')
                    .map(opt => opt.trim())
                    .filter(opt => opt.length > 0),
                correctAnswers: Array.isArray(poll.correctAnswers)
                    ? poll.correctAnswers
                        .filter(opt => typeof opt === 'string')
                        .map(opt => opt.trim())
                        .filter(opt => opt.length > 0)
                    : [],
                timeLimit: Math.min(Number(poll.timeLimit || 60), MAX_POLL_DURATION),
                createdAt: Date.now()
            };

            // Reset poll state
            answeredStudents.clear();
            results = {};
            activePoll = newPoll;

            console.log('New poll created:', activePoll);

            // Broadcast to all clients
            io.emit('poll-created', activePoll);
            broadcastChatMessage({
                sender: 'System',
                text: `New poll started: "${activePoll.question}"`,
                isSystem: true
            });

            callback?.({ status: 'success', poll: activePoll });

            // Auto-end timer
            if (activePoll.timeLimit > 0) {
                setTimeout(() => {
                    if (activePoll) {
                        console.log('Poll timeout reached');
                        io.emit('poll-ended');
                        broadcastChatMessage({
                            sender: 'System',
                            text: `Poll "${activePoll.question}" has ended`,
                            isSystem: true
                        });
                        activePoll = null;
                    }
                }, activePoll.timeLimit * 1000);
            }
        } catch (error) {
            console.error('Error in poll creation:', error);
            callback?.({ error: 'Poll creation failed' });
        }
    });

    // Handle answer submission
    socket.on('submit-answer', ({ answer, studentName, pollId }, callback) => {
        try {
            // Validation
            if (!activePoll || activePoll.question !== pollId) {
                return callback?.({ error: 'No active poll or poll ID mismatch' });
            }

            if (!activePoll.options.includes(answer)) {
                return callback?.({ error: 'Invalid answer' });
            }

            // Track answer
            answeredStudents.add(socket.id);
            results[answer] = (results[answer] || 0) + 1;
            const percentages = calculatePercentages();

            console.log(`Answer from ${studentName}:`, {
                answer,
                isCorrect: activePoll.correctAnswers.includes(answer),
                percentages
            });

            // Broadcast updates
            io.emit('results-updated', percentages);
            io.emit('participation-update', {
                answered: answeredStudents.size,
                total: connectedStudents.size
            });

            // Notify teacher specifically
            if (teacherSocket) {
                io.to(teacherSocket).emit('answers-status', {
                    answered: answeredStudents.size,
                    total: connectedStudents.size
                });
            }

            // Check completion
            if (checkAllStudentsAnswered()) {
                io.emit('all-students-answered');
                broadcastChatMessage({
                    sender: 'System',
                    text: 'All students have answered the poll!',
                    isSystem: true
                });
            }

            callback?.({
                status: 'success',
                isCorrect: activePoll.correctAnswers.includes(answer)
            });
        } catch (error) {
            console.error('Error in answer submission:', error);
            callback?.({ error: 'Answer submission failed' });
        }
    });

    // Handle poll ending
    socket.on('end-poll', (callback) => {
        try {
            if (!socket.isTeacher || socket.id !== teacherSocket) {
                return callback?.({ error: 'Unauthorized' });
            }

            if (activePoll) {
                console.log('Teacher ended poll manually');
                io.emit('poll-ended');
                broadcastChatMessage({
                    sender: 'System',
                    text: `Poll "${activePoll.question}" was ended by teacher`,
                    isSystem: true
                });
                activePoll = null;
                answeredStudents.clear();
                callback?.({ status: 'success' });
            } else {
                callback?.({ error: 'No active poll to end' });
            }
        } catch (error) {
            console.error('Error in ending poll:', error);
            callback?.({ error: 'Failed to end poll' });
        }
    });

    // Handle chat messages
    socket.on('teacher-message', (message) => {
        try {
            if (!socket.isTeacher || socket.id !== teacherSocket) {
                console.warn(`Unauthorized teacher message from ${socket.id}`);
                return;
            }

            if (!message?.text?.trim()) return;

            broadcastChatMessage({
                sender: 'Teacher',
                text: message.text.trim(),
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error in teacher message:', error);
        }
    });

    socket.on('student-message', (message) => {
        try {
            const student = connectedStudents.get(socket.id);
            if (!student) {
                console.warn(`Unauthenticated student message from ${socket.id}`);
                return;
            }

            if (!message?.text?.trim()) return;

            // Rate limiting
            if (isRateLimited(socket.id)) {
                socket.emit('chat-error', 'You are sending messages too quickly');
                return;
            }

            messageRateLimits.set(socket.id, Date.now());

            broadcastChatMessage({
                sender: student.name,
                text: message.text.trim(),
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error in student message:', error);
        }
    });

    // Handle student kicking
    socket.on('kick-student', (studentName, callback) => {
        try {
            if (!socket.isTeacher || socket.id !== teacherSocket) {
                return callback?.({ error: 'Unauthorized' });
            }

            // Find student socket
            const studentEntry = Array.from(connectedStudents.entries())
                .find(([_, student]) => student.name === studentName);
            
            if (studentEntry) {
                const [studentSocketId] = studentEntry;
                
                // Clean up state
                answeredStudents.delete(studentSocketId);
                connectedStudents.delete(studentSocketId);

                // Notify and disconnect
                io.to(studentSocketId).emit('you-were-kicked');
                io.sockets.sockets.get(studentSocketId)?.disconnect();

                console.log(`Student ${studentName} was kicked by teacher`);
                broadcastChatMessage({
                    sender: 'System',
                    text: `${studentName} was removed from the classroom`,
                    isSystem: true
                });

                // Update teacher
                if (activePoll) {
                    io.to(teacherSocket).emit('answers-status', {
                        answered: answeredStudents.size,
                        total: connectedStudents.size
                    });
                }

                callback?.({ status: 'success' });
            } else {
                callback?.({ error: 'Student not found' });
            }
        } catch (error) {
            console.error('Error in kicking student:', error);
            callback?.({ error: 'Failed to kick student' });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        try {
            console.log(`Disconnected: ${socket.id}`);

            const student = connectedStudents.get(socket.id);
            if (student) {
                connectedStudents.delete(socket.id);
                answeredStudents.delete(socket.id);
                console.log(`Student disconnected: ${student.name}`);
                
                broadcastStudentList();
                broadcastChatMessage({
                    sender: 'System',
                    text: `${student.name} left the classroom`,
                    isSystem: true
                });

                // Update teacher if needed
                if (activePoll && teacherSocket) {
                    io.to(teacherSocket).emit('answers-status', {
                        answered: answeredStudents.size,
                        total: connectedStudents.size
                    });
                }
            }

            if (socket.id === teacherSocket) {
                teacherSocket = null;
                console.log('Teacher disconnected');
            }
        } catch (error) {
            console.error('Error in disconnect handler:', error);
        }
    });

    // Send initial state to new connections
    const sendInitialState = () => {
        if (activePoll) {
            socket.emit('poll-created', activePoll);
            socket.emit('results-updated', calculatePercentages());
        }

        if (connectedStudents.has(socket.id)) {
            socket.emit('student-list-updated', Array.from(connectedStudents.values()).map(s => s.name));
        }

        socket.emit('chat-history', chatMessages);
    };

    sendInitialState();
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activePoll: !!activePoll,
        connections: io.engine.clientsCount,
        teacherConnected: !!teacherSocket,
        studentsConnected: connectedStudents.size,
        chatMessages: chatMessages.length,
        answeredStudents: answeredStudents.size,
        memoryUsage: process.memoryUsage()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Teacher password: ${TEACHER_PASSWORD}`);
});

// Cleanup on server shutdown
['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, () => {
        console.log(`Received ${signal}, shutting down gracefully...`);
        server.close(() => {
            console.log('Server terminated');
            process.exit(0);
        });
    });
});