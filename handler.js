const nodemailer = require("nodemailer");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const crypto = require("crypto");

// إعداد الاتصال بقاعدة بيانات DynamoDB
const client = new DynamoDBClient({});
const dynamoDb = DynamoDBDocumentClient.from(client);

// ---------------------------------------------------------
// 1. دالة إنشاء التصويت (Create Poll)
// ---------------------------------------------------------
exports.createPoll = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { question, options } = body;

    // التحقق من المدخلات
    if (!question || !options || !Array.isArray(options) || options.length < 2) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "يجب توفير سؤال وخيارين على الأقل" }),
      };
    }

    const pollId = crypto.randomUUID();
    const newPoll = {
      id: pollId,
      question: question,
      // تهيئة الخيارات مع عداد أصوات يبدأ من صفر
      options: options.map(opt => ({ name: opt, votes: 0 })), 
      createdAt: new Date().toISOString(),
    };

    await dynamoDb.send(
      new PutCommand({
        TableName: process.env.POLLS_TABLE,
        Item: newPoll,
      })
    );

    return {
      statusCode: 201,
      body: JSON.stringify({
        message: "تم إنشاء التصويت بنجاح",
        poll: newPoll,
      }),
    };
  } catch (error) {
    console.error("Error creating poll:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "حدث خطأ داخلي" }) };
  }
};

// ---------------------------------------------------------
// 2. دالة تسجيل التصويت (Submit Vote)
// ---------------------------------------------------------
exports.submitVote = async (event) => {
  try {
    const pollId = event.pathParameters.id;
    const body = JSON.parse(event.body);
    const { optionIndex } = body;

    if (optionIndex === undefined || typeof optionIndex !== 'number') {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "يجب تحديد رقم الخيار الصحيح" }),
      };
    }

    // تحديث عداد الأصوات للخيار المحدد باستخدام Index
    const result = await dynamoDb.send(
      new UpdateCommand({
        TableName: process.env.POLLS_TABLE,
        Key: { id: pollId },
        UpdateExpression: `SET options[${optionIndex}].votes = options[${optionIndex}].votes + :inc`,
        ExpressionAttributeValues: {
          ":inc": 1,
        },
        ReturnValues: "ALL_NEW",
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "تم تسجيل تصويتك بنجاح",
        poll: result.Attributes,
      }),
    };
  } catch (error) {
    console.error("Error submitting vote:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "حدث خطأ أثناء تسجيل الصوت" }) };
  }
};

// ---------------------------------------------------------
// 3. دالة جلب التصويت والنتائج (Get Poll)
// ---------------------------------------------------------
exports.getPoll = async (event) => {
  try {
    const pollId = event.pathParameters.id;

    const result = await dynamoDb.send(
      new GetCommand({
        TableName: process.env.POLLS_TABLE,
        Key: { id: pollId },
      })
    );

    if (!result.Item) {
      return { statusCode: 404, body: JSON.stringify({ message: "التصويت غير موجود" }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(result.Item),
    };
  } catch (error) {
    console.error("Error fetching poll:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "حدث خطأ أثناء جلب البيانات" }) };
  }
};

// ---------------------------------------------------------
// 4. دالة إرسال النتائج عبر الإيميل (Send Results)
// ---------------------------------------------------------
exports.sendResults = async (event) => {
  try {
    const pollId = event.pathParameters.id;
    const body = JSON.parse(event.body);
    
    // نستقبل الإيميل بدلاً من Destination ID
    const { targetEmail } = body; 

    if (!targetEmail) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ message: "يجب توفير البريد الإلكتروني" }) 
      };
    }

    const pollData = await dynamoDb.send(
      new GetCommand({
        TableName: process.env.POLLS_TABLE,
        Key: { id: pollId },
      })
    );

    if (!pollData.Item) {
      return { statusCode: 404, body: JSON.stringify({ message: "التصويت غير موجود" }) };
    }

    const poll = pollData.Item;
    const totalVotes = poll.options.reduce((sum, opt) => sum + opt.votes, 0);

    let emailText = `📊 نتائج التصويت الخاص بك\n\n`;
    emailText += `السؤال: ${poll.question}\n`;
    emailText += `إجمالي الأصوات: ${totalVotes}\n\n`;
    emailText += `التفاصيل:\n`;
    poll.options.forEach(opt => {
      emailText += `- ${opt.name}: ${opt.votes} صوت\n`;
    });

    // إعداد الاتصال بخادم SMTP (سيسحب البيانات من ملف .env)
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // إرسال الإيميل
    await transporter.sendMail({
      from: '"منصة التصويت" <noreply@pollingapp.com>',
      to: targetEmail,
      subject: `نتائج التصويت: ${poll.question}`,
      text: emailText,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "تم إرسال النتائج إلى بريدك بنجاح" }),
    };
  } catch (error) {
    console.error("Error sending email:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "حدث خطأ أثناء إرسال النتائج" }) };
  }
};
// 5. دالة جلب جميع التصويتات (List Polls)
exports.listPolls = async () => {
  try {
    const result = await dynamoDb.send(
      new ScanCommand({
        TableName: process.env.POLLS_TABLE,
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify(result.Items || []),
    };
  } catch (error) {
    console.error("Error listing polls:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "حدث خطأ أثناء جلب القائمة" }) };
  }
};