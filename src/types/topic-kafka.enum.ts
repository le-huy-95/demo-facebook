/**
 * Kafka topic constants — demo dùng in-process bus, production map sang Kafka thật.
 * Tương thích naming với top.ai_chat/libs/shared.
 */
export enum TopicKafka {
  FORWARD_MESSAGE_SEND = 'FORWARD_MESSAGE_SEND',
  SOCKET_MESSAGE_RECEIVE = 'SOCKET_MESSAGE_RECEIVE',
  SOCKET_MESSAGE_SEND_RESULT = 'SOCKET_MESSAGE_SEND_RESULT',
}
