const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
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
// 4. دالة إرسال النتائج إلى ClickUp (Send Results)
// ---------------------------------------------------------
exports.sendResults = async (event) => {
  try {
    const pollId = event.pathParameters.id;
    const body = JSON.parse(event.body);
    const { destinationId } = body; 

    if (!destinationId) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ message: "يجب توفير معرف الوجهة (Destination ID) الخاص بـ ClickUp" }) 
      };
    }

    // جلب بيانات التصويت
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

    // تجهيز الرسالة
    let messageText = `📊 *نتائج التصويت الخاص بك*\n\n`;
    messageText += `*السؤال:* ${poll.question}\n`;
    messageText += `*إجمالي الأصوات:* ${totalVotes}\n\n`;
    messageText += `*التفاصيل:*\n`;
    poll.options.forEach(opt => {
      messageText += `- ${opt.name}: ${opt.votes} صوت\n`;
    });

    // إرسال الطلب إلى ClickUp API
    const clickupApiUrl = `https://api.clickup.com/api/v2/view/${destinationId}/comment`;
    
    const response = await fetch(clickupApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': process.env.CLICKUP_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        comment_text: messageText,
        notify_all: true
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("ClickUp Error Details:", errorData);
      throw new Error(`خطأ من ClickUp: ${response.statusText}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "تم إرسال النتائج إلى ClickUp بنجاح" }),
    };
  } catch (error) {
    console.error("Error sending to ClickUp:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "حدث خطأ أثناء إرسال النتائج" }) };
  }
};