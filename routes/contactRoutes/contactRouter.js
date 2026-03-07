import express from 'express';
import { handleEnquiry } from '../../controllers/contact-controllers/enquiryController.js';
import { handleFeedback } from '../../controllers/contact-controllers/feedbackController.js';
import { optionalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';
const contactRouter = express.Router();

contactRouter.post('/enquiry', handleEnquiry);
contactRouter.post('/feedback', optionalTokenVerifier, handleFeedback);
export default contactRouter;
