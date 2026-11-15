       IDENTIFICATION DIVISION.
       PROGRAM-ID. NIGHTINT.
       AUTHOR. SAVINGS TEAM.
       DATE-WRITTEN. 03/1998.
      *----------------------------------------------------------------
      * NIGHTLY BATCH : CREDIT INTEREST ON SAVINGS ACCOUNTS
      * READS THE ACCOUNTS, CALLS CALCINT, CREDITS AND TOTALS.
      * RUN BY THE JOB NIGHTINT AT 2 AM.
      * MUE EXAMPLE - FICTIONAL SYSTEM
      *----------------------------------------------------------------
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           EXEC SQL INCLUDE SQLCA END-EXEC.
           COPY ACCTREC.
       01  WS-CALC-AREA.
      *    CALENDAR QUARTER : 91 DAYS
           05  WS-DAYS             PIC 9(3)       VALUE 91.
           05  WS-INTEREST         PIC S9(9)V99   COMP-3.
           05  WS-RETURN-CODE      PIC X(2).
       01  WS-COUNTERS.
           05  WS-READ-COUNT       PIC 9(7)       VALUE ZERO.
           05  WS-CREDITED-COUNT   PIC 9(7)       VALUE ZERO.
           05  WS-TOTAL-INTEREST   PIC S9(11)V99  COMP-3 VALUE ZERO.
       77  WS-END-CURSOR           PIC X          VALUE 'N'.
           88  END-OF-CURSOR                      VALUE 'Y'.
           EXEC SQL DECLARE C-ACCOUNTS CURSOR FOR
                SELECT ACCOUNT_NO, STATUS, AVG_BALANCE, RATE
                  FROM ACCOUNTS
                 WHERE ACCOUNT_TYPE = 'SAV'
           END-EXEC.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-OPEN
           PERFORM 2000-PROCESS-ACCOUNT UNTIL END-OF-CURSOR
           PERFORM 3000-CLOSE
           DISPLAY 'NIGHTINT ACCOUNTS READ     : ' WS-READ-COUNT
           DISPLAY 'NIGHTINT ACCOUNTS CREDITED : ' WS-CREDITED-COUNT
           DISPLAY 'NIGHTINT TOTAL INTEREST    : ' WS-TOTAL-INTEREST
           STOP RUN.
      *
       1000-OPEN.
           EXEC SQL OPEN C-ACCOUNTS END-EXEC
           PERFORM 2100-READ-NEXT.
      *
       2000-PROCESS-ACCOUNT.
           ADD 1 TO WS-READ-COUNT
           CALL 'CALCINT' USING ACCT-REC WS-CALC-AREA
           IF WS-RETURN-CODE = '00' AND WS-INTEREST > ZERO
              ADD WS-INTEREST TO WS-TOTAL-INTEREST
              ADD 1 TO WS-CREDITED-COUNT
              PERFORM 2200-CREDIT
           END-IF
           PERFORM 2100-READ-NEXT.
      *
       2100-READ-NEXT.
           EXEC SQL FETCH C-ACCOUNTS
                INTO :ACCT-NUMBER, :ACCT-STATUS, :ACCT-BALANCE,
                     :ACCT-RATE
           END-EXEC
           IF SQLCODE = 100
              SET END-OF-CURSOR TO TRUE
           END-IF.
      *
       2200-CREDIT.
           EXEC SQL UPDATE ACCOUNTS
                   SET BALANCE = BALANCE + :WS-INTEREST
                 WHERE ACCOUNT_NO = :ACCT-NUMBER
           END-EXEC.
      *
       3000-CLOSE.
           EXEC SQL CLOSE C-ACCOUNTS END-EXEC.
