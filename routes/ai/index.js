import express from 'express';
import chatRoutes from './chat.js';
import modelsRoutes from './models.js';
import conversationsRoutes from './conversations.js';
import imagesRoutes from './images.js';
import codeRoutes from './code.js';

const router = express.Router();

router.use('/chat', chatRoutes);
router.use('/models', modelsRoutes);
router.use('/conversations', conversationsRoutes);
router.use('/images', imagesRoutes);
router.use('/code', codeRoutes);

export default router;
