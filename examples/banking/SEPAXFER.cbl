       IDENTIFICATION DIVISION.
       PROGRAM-ID. SEPAXFER.
       AUTHOR. PAYMENTS TEAM.
       DATE-WRITTEN. 11/2008.
      *----------------------------------------------------------------
      * OUTGOING SEPA TRANSFER CHECKS AND ROUTING
      * INVALID IBAN : REJECT RJ01. ABOVE THE DAILY LIMIT : AT02.
      * OTHERWISE FORMAT AS PAIN.001 AND SEND.
      * MUE EXAMPLE - FICTIONAL SYSTEM
      *----------------------------------------------------------------
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           EXEC SQL INCLUDE SQLCA END-EXEC.
       01  WS-CHECK.
           05  WS-IBAN-OK          PIC X.
      *    DAILY LIMIT READ FROM THE CUSTOMER PROFILE
       77  WS-DAILY-LIMIT          PIC 9(7)V99   COMP-3.
       77  WS-REJECT-CODE          PIC X(4).
       LINKAGE SECTION.
           COPY XFERREC.
       PROCEDURE DIVISION USING XFER-REC.
       0000-MAIN.
           PERFORM 1000-CHECK-IBAN
           IF WS-IBAN-OK = 'N'
              MOVE 'RJ01' TO WS-REJECT-CODE
              MOVE 'RJ01' TO XFER-STATUS
              PERFORM 8000-WRITE-REJECT
              GO TO 9999-EXIT
           END-IF
           PERFORM 2000-READ-LIMIT
           IF XFER-AMOUNT > WS-DAILY-LIMIT
              MOVE 'AT02' TO XFER-STATUS
              PERFORM 3000-PUT-ON-HOLD
           ELSE
              MOVE 'OK00' TO XFER-STATUS
              PERFORM 4000-FORMAT-PAIN001
           END-IF.
       9999-EXIT.
           GOBACK.
      *
       1000-CHECK-IBAN.
           CALL 'IBANCHK' USING XFER-REC WS-CHECK.
      *
       2000-READ-LIMIT.
           EXEC SQL
              SELECT DAILY_LIMIT
                INTO :WS-DAILY-LIMIT
                FROM CUSTOMERS
               WHERE CUSTOMER_ID = :XFER-CUSTOMER
           END-EXEC
           IF SQLCODE NOT = ZERO
              MOVE ZERO TO WS-DAILY-LIMIT
           END-IF.
      *
       3000-PUT-ON-HOLD.
      *    PICKED UP BY THE 2 PM BATCH (XFER14H)
           EXEC SQL
              INSERT INTO PENDING_TRANSFERS (REFERENCE, REASON)
              VALUES (:XFER-REFERENCE, 'AT02')
           END-EXEC.
      *
       4000-FORMAT-PAIN001.
           CALL 'FMTPAIN' USING XFER-REC.
      *
       8000-WRITE-REJECT.
           EXEC SQL
              INSERT INTO REJECTS (REFERENCE, REJECT_CODE)
              VALUES (:XFER-REFERENCE, :WS-REJECT-CODE)
           END-EXEC.
