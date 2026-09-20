import mongoose from "mongoose";

const connectToDB = async()=>{
    try {
        await mongoose.connect(process.env.MONGODB_URI!);
        console.log("Connected to DB");
    } catch (error) {
        console.error(`Error in connecting DB: ${error}`);
        process.exit(1);
    }
}

export default connectToDB;