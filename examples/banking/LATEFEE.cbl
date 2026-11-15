       IDENTIFICATION DIVISION.
       PROGRAM-ID. LATEFEE.
       AUTHOR. COLLECTIONS TEAM.
       DATE-WRITTEN. 02/06/2003.
      *----------------------------------------------------------------
      * LATE PAYMENT PENALTIES ON UNPAID LOAN INSTALLMENTS
      * CALLED BY THE COLLECTIONS BATCH COLLECT.
      * MUE EXAMPLE - FICTIONAL SYSTEM
      *----------------------------------------------------------------
       ENVIRONMENT DIVISION.
       CONFIGURATION SECTION.
       SPECIAL-NAMES.
           DECIMAL-POINT IS COMMA.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           EXEC SQL INCLUDE SQLCA END-EXEC.
      *    CONTRACTUAL PENALTY RATE : 7 %
       77  WS-PENALTY-RATE         PIC 9V99      VALUE 0,07.
      *    GRACE PERIOD IN DAYS
       77  WS-GRACE-DAYS           PIC 9(2)      VALUE 15.
      *    PENALTY CAP PER INSTALLMENT (READ FROM THE CONTRACT)
       77  WS-CAP                  PIC 9(5)V99   COMP-3.
       77  WS-PENALTY              PIC 9(7)V99   COMP-3.
       LINKAGE SECTION.
       01  LK-INSTALLMENT.
           05  LK-CONTRACT-NO      PIC X(10).
           05  LK-INSTALLMENT-NO   PIC 9(3).
      *    AMOUNT DUE ON THE UNPAID INSTALLMENT
           05  LK-AMOUNT-DUE       PIC 9(7)V99   COMP-3.
      *    NUMBER OF DAYS LATE
           05  LK-DAYS-LATE        PIC 9(4).
           05  LK-PENALTY          PIC 9(7)V99   COMP-3.
       PROCEDURE DIVISION USING LK-INSTALLMENT.
       0000-MAIN.
           IF LK-DAYS-LATE > WS-GRACE-DAYS
              PERFORM 1000-READ-CAP
              COMPUTE WS-PENALTY ROUNDED =
                 LK-AMOUNT-DUE * WS-PENALTY-RATE
              IF WS-PENALTY > WS-CAP
                 MOVE WS-CAP TO WS-PENALTY
              END-IF
           ELSE
              MOVE ZERO TO WS-PENALTY
           END-IF
           MOVE WS-PENALTY TO LK-PENALTY
           PERFORM 2000-SAVE
           GOBACK.
      *
       1000-READ-CAP.
           EXEC SQL
              SELECT PENALTY_CAP
                INTO :WS-CAP
                FROM CONTRACTS
               WHERE CONTRACT_NO = :LK-CONTRACT-NO
           END-EXEC
      *    CONTRACT NOT FOUND : DEFAULT CAP OF 50
           IF SQLCODE NOT = ZERO
              MOVE 50 TO WS-CAP
           END-IF.
      *
       2000-SAVE.
           EXEC SQL
              UPDATE INSTALLMENTS
                 SET PENALTY = :WS-PENALTY
               WHERE CONTRACT_NO = :LK-CONTRACT-NO
                 AND INSTALLMENT_NO = :LK-INSTALLMENT-NO
           END-EXEC.
